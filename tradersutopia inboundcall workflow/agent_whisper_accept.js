/**
 * /agent_whisper_accept
 *
 * INVOCATION:  Twilio Voice webhook (POST) – Gather action from /agent_whisper
 * RETURNS:     TwiML  →  callback(null, twiml)
 *
 * PURPOSE:
 *   Evaluate the digit the agent pressed.
 *   If "1" → join the caller's conference AND cancel other ringing agent calls.
 *   Anything else → hang up this agent only; caller and other agents keep ringing.
 *   Full behavior: VOICE_FLOW.md
 *
 * EXPECTED event params (POST body from Twilio):
 *   conferenceName  – passed as query param on the action URL
 *   Digits          – the key the agent pressed
 *   CallSid         – Twilio-injected SID of this agent leg
 *   Called / To      – the agent number
 *
 * REQUIRED env vars:
 *   FROM_NUMBER     – needed to identify our outbound calls when cancelling others
 */
exports.handler = async function (context, event, callback) {
  // ── RAW EVENT DUMP (diagnostic — check Twilio Live Logs) ───────────
  console.log("ACCEPT_RAW_EVENT=" + JSON.stringify(event));

  // ── Correlation & logging ──────────────────────────────────────────
  var requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var FN = 'agent_whisper_accept';

  // ── Robust conferenceName extraction ───────────────────────────────
  //    Gather action URL sends ?conferenceName=... as query param.
  //    Twilio *should* merge it into event, but casing/location varies.
  var conferenceName = '';
  if (event.conferenceName) {
    conferenceName = event.conferenceName;
  } else if (event.ConferenceName) {
    conferenceName = event.ConferenceName;
  } else if (event.body && typeof event.body === 'object' && event.body.conferenceName) {
    conferenceName = event.body.conferenceName;
  } else {
    var rawBody = (typeof event.body === 'string') ? event.body
               : (typeof event.Body === 'string') ? event.Body : '';
    if (rawBody) {
      var bodyMatch = rawBody.match(/conferenceName=([^&]+)/);
      if (bodyMatch) conferenceName = decodeURIComponent(bodyMatch[1]);
    }
  }
  conferenceName = (conferenceName || '').trim();

  var digit = (event.Digits || event.digits || '').trim();
  var agentCallSid = (event.CallSid || '').trim();
  var agentNumber = (event.Called || event.To || '').trim();

  console.log("ACCEPT_PARSED_conferenceName=" + conferenceName);
  console.log("ACCEPT_DIGITS=" + digit);

  var correlation = { requestId: requestId, conferenceName: conferenceName, agentCallSid: agentCallSid, agentNumber: agentNumber };

  function log(level, step, extra) {
    console.log(JSON.stringify(
      Object.assign({ level: level, fn: FN, step: step }, correlation, extra || {}, { ts: new Date().toISOString() })
    ));
  }

  log('info', 'START', {
    source: 'voice_webhook_gather_action',
    digit: digit,
    conferenceName: conferenceName,
    eventKeys: Object.keys(event || {})
  });

  var twiml = new Twilio.twiml.VoiceResponse();

  // ── Validate ───────────────────────────────────────────────────────
  if (!conferenceName) {
    log('warn', 'MISSING_PARAM', { missing: 'conferenceName' });
    twiml.say('System error. Goodbye.');
    twiml.hangup();
    log('info', 'END', { outcome: 'error_missing_param' });
    return callback(null, twiml);
  }

  if (digit !== '1') {
    log('info', 'WRONG_DIGIT', { digit: digit });
    var baseUrl = (context.BASE_URL || ('https://' + context.DOMAIN_NAME)).replace(/\/+$/, '');
    var retryWhisperUrl = baseUrl + '/agent_whisper?conferenceName=' + encodeURIComponent(conferenceName) + '&try=1';
    twiml.say('Invalid input.');
    twiml.redirect({ method: 'POST' }, retryWhisperUrl);
    log('info', 'END', { outcome: 'wrong_digit_retry', digit: digit });
    return callback(null, twiml);
  }

  // ── Agent accepted ─────────────────────────────────────────────────
  log('info', 'ACCEPTED', { agentNumber: agentNumber, digit: digit });

  // ── Cancel other ringing agent calls FOR THIS CONFERENCE ONLY ──────
  var client = context.getTwilioClient();
  var syncSid = (context.SYNC_SERVICE_SID || '').trim();
  var SYNC_MAP = 'call_routing';

  // Try Sync first; if Sync fails, fall back to REST API (never skip cancellation)
  var cancelledViaSyncOk = false;
  try {
    if (syncSid) {
      var confItem = await client.sync.v1.services(syncSid)
        .syncMaps(SYNC_MAP)
        .syncMapItems(conferenceName)
        .fetch();
      var siblingCallSids = (confItem.data.callSids || []).filter(function (sid) {
        return sid !== agentCallSid;
      });
      log('info', 'CANCELLING_OTHERS', { count: siblingCallSids.length, via: 'sync' });
      for (var i = 0; i < siblingCallSids.length; i++) {
        try {
          await client.calls(siblingCallSids[i]).update({ status: 'completed' });
          log('info', 'CANCELLED_CALL', { cancelledSid: siblingCallSids[i] });
        } catch (cancelErr) {
          log('warn', 'CANCEL_FAILED', { cancelledSid: siblingCallSids[i], message: cancelErr.message });
        }
      }
      cancelledViaSyncOk = true;
    }
  } catch (syncCancelErr) {
    log('warn', 'SYNC_CANCEL_FAILED', { message: syncCancelErr.message, status: syncCancelErr.status });
  }

  // Fallback: REST API with call.url filtering (if Sync wasn't used or failed)
  if (!cancelledViaSyncOk) {
    try {
      var FROM_NUMBER = (context.FROM_NUMBER || '').trim();
      if (FROM_NUMBER) {
        var ringingCalls = await client.calls.list({ from: FROM_NUMBER, status: 'ringing', limit: 20 });
        var queuedCalls = await client.calls.list({ from: FROM_NUMBER, status: 'queued', limit: 20 });
        var otherCalls = ringingCalls.concat(queuedCalls).filter(function (c) {
          return c.sid !== agentCallSid && c.url && c.url.indexOf(conferenceName) !== -1;
        });
        log('info', 'CANCELLING_OTHERS', { count: otherCalls.length, via: 'rest_api_fallback' });
        for (var j = 0; j < otherCalls.length; j++) {
          try {
            await client.calls(otherCalls[j].sid).update({ status: 'completed' });
            log('info', 'CANCELLED_CALL', { cancelledSid: otherCalls[j].sid });
          } catch (cancelErr2) {
            log('warn', 'CANCEL_FAILED', { cancelledSid: otherCalls[j].sid, message: cancelErr2.message });
          }
        }
      }
    } catch (restCancelErr) {
      log('warn', 'CANCEL_BATCH_ERROR', { message: restCancelErr.message });
    }
  }

  // ── Post "agent on call" to callback dashboard ──────────────────
  var callbackUrl = (context.CALLBACK_SCRIPT_URL || '').trim();
  if (callbackUrl) {
    try {
      var https = require('https');
      var callerCallSid = conferenceName.replace(/^TU_/, '');
      var callerNumber = (event.From || '').trim();
      var allAgents = (context.AGENT_LIST || '').split(',').map(function (n) { return n.trim(); }).filter(Boolean);
      var otherAgents = allAgents.filter(function (n) { return n !== agentNumber; });

      var postBody = JSON.stringify({
        event: 'agent_on_call',
        agent: agentNumber,
        other_agents: otherAgents,
        conference_name: conferenceName,
        caller_call_sid: callerCallSid,
        caller_number: callerNumber,
        timestamp: new Date().toISOString()
      });

      var url = new URL(callbackUrl);
      await new Promise(function (resolve, reject) {
        var req = https.request({
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postBody)
          },
          timeout: 5000
        }, function (res) {
          var body = '';
          res.on('data', function (chunk) { body += chunk; });
          res.on('end', function () { resolve({ statusCode: res.statusCode, body: body }); });
        });
        req.on('error', function (err) { reject(err); });
        req.on('timeout', function () { req.destroy(); reject(new Error('Request timed out')); });
        req.write(postBody);
        req.end();
      });
      log('info', 'DASHBOARD_NOTIFIED', { agent: agentNumber, otherAgents: otherAgents });
    } catch (dashErr) {
      log('warn', 'DASHBOARD_NOTIFY_FAILED', { message: dashErr.message });
    }
  }

  // ── SMS notify other agents that this agent took the call ─────────
  var smsFromNumber = (context.SMS_FROM_NUMBER || context.FROM_NUMBER || '').trim();
  if (smsFromNumber) {
    try {
      var smsAgentList = (context.AGENT_LIST || '').split(',').map(function (n) { return n.trim(); }).filter(Boolean);
      var smsRecipients = smsAgentList.filter(function (n) { return n !== agentNumber; });

      if (smsRecipients.length > 0) {
        var now = new Date();
        var timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
        var smsBody = 'Traders Utopia: Agent ' + agentNumber + ' has taken an inbound call at ' + timeStr + ' ET. This was not a missed call.';

        log('info', 'SENDING_SMS', { recipients: smsRecipients, from: smsFromNumber });
        for (var s = 0; s < smsRecipients.length; s++) {
          try {
            await client.messages.create({
              to: smsRecipients[s],
              from: smsFromNumber,
              body: smsBody
            });
            log('info', 'SMS_SENT', { to: smsRecipients[s] });
          } catch (smsErr) {
            log('warn', 'SMS_FAILED', { to: smsRecipients[s], message: smsErr.message });
          }
        }
      }
    } catch (smsOuterErr) {
      log('warn', 'SMS_NOTIFICATION_ERROR', { message: smsOuterErr.message });
    }
  }

  // ── Join the conference ────────────────────────────────────────────
  log('info', 'JOINING_CONFERENCE', { conferenceName: conferenceName });

  var baseUrl = (context.BASE_URL || ('https://' + context.DOMAIN_NAME)).replace(/\/+$/, '');
  var statusCallbackUrl = baseUrl + '/conference_status_callback';

  var dial = twiml.dial();
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit: false,
      beep: false,
      statusCallback: statusCallbackUrl,
      statusCallbackEvent: 'start end join leave',
      statusCallbackMethod: 'POST'
    },
    conferenceName
  );

  log('info', 'END', { outcome: 'joining_conference', conferenceName: conferenceName });
  return callback(null, twiml);
};
