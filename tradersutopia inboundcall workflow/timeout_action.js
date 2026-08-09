/**
 * /timeout_action
 *
 * INVOCATION:  Twilio Voice webhook (POST) – <Gather> action from /join_conference
 * RETURNS:     TwiML  →  callback(null, twiml)
 *
 * PURPOSE:
 *   Handles the caller's digit input after the conference ends:
 *     Digit 1 → Log callback request (POST to CALLBACK_SCRIPT_URL), confirm, hangup
 *     Digit 2 → Ring agents again, join a new conference (full retry)
 *     Other   → Goodbye, hangup
 *
 * EXPECTED event params:
 *   Digits        – from <Gather>
 *   callerNumber  – query param from /join_conference
 *   callSid       – query param from /join_conference
 *   CallSid       – Twilio-injected (same call)
 *   From / Caller – Twilio-injected caller number
 *
 * OPTIONAL env:
 *   CALLBACK_SCRIPT_URL – Google Script (or other webhook) to log callbacks
 *   AGENT_LIST          – comma-separated agent phone numbers
 *   FROM_NUMBER         – Twilio number to call agents from
 */
async function loadCallRouting(context, calledNumber, log) {
  var fallbackAgents = (context.AGENT_LIST || '')
    .split(',').map(function (number) { return number.trim(); }).filter(Boolean);
  var fallbackFrom = calledNumber || (context.FROM_NUMBER || '').trim();
  var endpoint = (context.CALL_ROUTING_URL || '').trim();
  var secret = (context.CALL_ROUTING_SECRET || '').trim();

  if (!endpoint || !secret) {
    log('warn', 'ROUTING_ENV_FALLBACK', { reason: 'runtime endpoint or secret is missing' });
    return { agents: fallbackAgents, fromNumber: fallbackFrom, source: 'environment' };
  }

  try {
    var https = require('https');
    var url = new URL(endpoint);
    url.searchParams.set('calledNumber', calledNumber || '');
    var response = await new Promise(function (resolve, reject) {
      var req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { 'x-call-routing-secret': secret },
        timeout: 4000
      }, function (res) {
        var body = '';
        res.on('data', function (chunk) { body += chunk; });
        res.on('end', function () { resolve({ statusCode: res.statusCode, body: body }); });
      });
      req.on('error', reject);
      req.on('timeout', function () { req.destroy(); reject(new Error('Routing request timed out')); });
      req.end();
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error('Routing API returned ' + response.statusCode);
    }

    var data = JSON.parse(response.body || '{}');
    if (!data.ok || !Array.isArray(data.agents)) throw new Error('Invalid routing response');
    var agents = data.agents
      .map(function (number) { return String(number).trim(); })
      .filter(function (number) { return /^\+[1-9]\d{7,14}$/.test(number); });
    var fromNumber = String(data.fromNumber || fallbackFrom).trim();
    if (!/^\+[1-9]\d{7,14}$/.test(fromNumber)) throw new Error('Invalid routing caller ID');
    log('info', 'ROUTING_LOADED', { source: 'dashboard', agentCount: agents.length, fromNumber: fromNumber });
    return { agents: agents, fromNumber: fromNumber, source: 'dashboard' };
  } catch (error) {
    log('error', 'ROUTING_API_UNAVAILABLE', { message: error.message });
    return { agents: [], fromNumber: fallbackFrom, source: 'dashboard_unavailable' };
  }
}

exports.handler = async function (context, event, callback) {
  var requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var FN = 'timeout_action';

  var digit = (event.Digits || event.digits || '').trim();
  var callSid = (event.callSid || event.CallSid || '').trim();
  var callerNumber = (event.callerNumber || event.From || event.Caller || '').trim();
  var calledNumber = (event.calledNumber || event.To || event.Called || '').trim();
  var baseUrl = (context.BASE_URL || ('https://' + context.DOMAIN_NAME)).replace(/\/+$/, '');

  var correlation = { requestId: requestId, callSid: callSid, callerNumber: callerNumber, calledNumber: calledNumber, digit: digit };

  function log(level, step, extra) {
    console.log(JSON.stringify(
      Object.assign({ level: level, fn: FN, step: step }, correlation, extra || {}, { ts: new Date().toISOString() })
    ));
  }

  console.log("TIMEOUT_ACTION_RAW_EVENT=" + JSON.stringify(event));
  log('info', 'START', { eventKeys: Object.keys(event || {}) });

  var twiml = new Twilio.twiml.VoiceResponse();

  // ═══════════════════════════════════════════════════════════════════
  //  DIGIT 1 → CALLBACK REQUEST
  // ═══════════════════════════════════════════════════════════════════
  if (digit === '1') {
    log('info', 'CALLBACK_REQUESTED', { callerNumber: callerNumber });

    var callbackUrl = (context.CALLBACK_SCRIPT_URL || '').trim();

    if (callbackUrl && callerNumber) {
      try {
        // POST to callback script as JSON — matches Studio http_1 format exactly
        var postBody = JSON.stringify({
          event: 'callback_requested',
          caller: callerNumber,
          called_number: calledNumber,
          digits: '1',
          call_sid: callSid,
          timestamp: new Date().toISOString()
        });
        log('info', 'CALLBACK_POSTING', { callbackUrl: callbackUrl, bodyLength: postBody.length });

        // Use built-in https module (got is not available in Twilio Functions)
        var https = require('https');
        var url = new URL(callbackUrl);
        var postResult = await new Promise(function (resolve, reject) {
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
        log('info', 'CALLBACK_LOGGED', { callbackUrl: callbackUrl, statusCode: postResult.statusCode });
      } catch (err) {
        log('error', 'CALLBACK_FAILED', { message: err.message });
        // Non-fatal — still confirm to caller
      }
    } else {
      log('warn', 'CALLBACK_SKIPPED', {
        hasUrl: !!callbackUrl,
        hasNumber: !!callerNumber
      });
    }

    twiml.say('Perfect. We have logged your callback request. We will call you back as soon as possible.');
    twiml.hangup();

    log('info', 'END', { outcome: 'callback_confirmed' });
    return callback(null, twiml);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  DIGIT 2 → RETRY AGENTS
  // ═══════════════════════════════════════════════════════════════════
  if (digit === '2') {
    var newConferenceName = 'TU_' + callSid + '_' + Date.now();
    log('info', 'RETRY_AGENTS', { newConferenceName: newConferenceName });

    // Ring agents (same logic as simulring_agents)
    var routing = await loadCallRouting(context, calledNumber, log);
    var fromNumber = routing.fromNumber;
    var agents = routing.agents;

    if (!fromNumber) {
      log('error', 'MISSING_FROM_NUMBER', {});
      twiml.say('System configuration error. Please try again later. Goodbye.');
      twiml.hangup();
      return callback(null, twiml);
    }

    var whisperUrl = baseUrl + '/agent_whisper'
      + '?conferenceName=' + encodeURIComponent(newConferenceName)
      + '&callerCallSid=' + encodeURIComponent(callSid)
      + '&callerNumber=' + encodeURIComponent(callerNumber)
      + '&calledNumber=' + encodeURIComponent(calledNumber)
      + '&routingAgents=' + encodeURIComponent(agents.join(','));
    var client = context.getTwilioClient();
    var syncSid = (context.SYNC_SERVICE_SID || '').trim();
    var SYNC_MAP = 'call_routing';

    // Atomic agent availability check (fail-open: Sync errors → dial anyway)
    var retryAvailable = [];
    if (syncSid) {
      var retrySyncReady = false;
      try {
        await client.sync.v1.services(syncSid).syncMaps.create({ uniqueName: SYNC_MAP });
        retrySyncReady = true;
      } catch (mapErr) {
        retrySyncReady = (mapErr.status === 409);
        if (!retrySyncReady) { log('error', 'RETRY_SYNC_MAP_FAILED', { message: mapErr.message, status: mapErr.status }); }
      }

      if (retrySyncReady) {
        for (var ra = 0; ra < agents.length; ra++) {
          var retryAgent = agents[ra];
          try {
            await client.sync.v1.services(syncSid)
              .syncMaps(SYNC_MAP)
              .syncMapItems
              .create({ key: retryAgent, data: { conferenceName: newConferenceName, claimedAt: Date.now() }, ttl: 300 });
            retryAvailable.push(retryAgent);
            log('info', 'RETRY_AGENT_CLAIMED', { agentNumber: retryAgent, via: 'sync' });
          } catch (claimErr) {
            if (claimErr.status === 409) {
              log('info', 'RETRY_AGENT_BUSY', { agentNumber: retryAgent, via: 'sync' });
            } else {
              log('warn', 'RETRY_SYNC_CLAIM_ERROR', { agentNumber: retryAgent, message: claimErr.message, status: claimErr.status });
              retryAvailable.push(retryAgent);
            }
          }
        }
      } else {
        log('warn', 'RETRY_SYNC_UNAVAILABLE_FALLBACK', {});
        for (var rfb = 0; rfb < agents.length; rfb++) {
          var rfbAgent = agents[rfb];
          try {
            var rfbBusy = await client.calls.list({ to: rfbAgent, from: fromNumber, status: 'in-progress', limit: 1 });
            if (rfbBusy.length > 0) {
              log('info', 'RETRY_AGENT_BUSY', { agentNumber: rfbAgent, via: 'rest_api_fallback' });
            } else {
              retryAvailable.push(rfbAgent);
            }
          } catch (rfbErr) {
            log('warn', 'RETRY_AVAILABILITY_CHECK_FAILED', { agentNumber: rfbAgent, message: rfbErr.message });
            retryAvailable.push(rfbAgent);
          }
        }
      }
    } else {
      for (var rb = 0; rb < agents.length; rb++) {
        var retryAgentFb = agents[rb];
        try {
          var retryBusy = await client.calls.list({ to: retryAgentFb, from: fromNumber, status: 'in-progress', limit: 1 });
          if (retryBusy.length > 0) {
            log('info', 'RETRY_AGENT_BUSY', { agentNumber: retryAgentFb, via: 'rest_api', activeCallSid: retryBusy[0].sid });
          } else {
            retryAvailable.push(retryAgentFb);
          }
        } catch (retryCheckErr) {
          log('warn', 'RETRY_AVAILABILITY_CHECK_FAILED', { agentNumber: retryAgentFb, message: retryCheckErr.message });
          retryAvailable.push(retryAgentFb);
        }
      }
    }

    if (retryAvailable.length === 0) {
      log('warn', 'RETRY_NO_AGENTS_AVAILABLE', {});
      twiml.say('All agents are currently on other calls. Please try again later. Goodbye.');
      twiml.hangup();
      return callback(null, twiml);
    }

    var retryStatusBase = baseUrl + '/agent_call_status';
    var retryCallSids = [];
    var callPromises = retryAvailable.map(function (agentNumber) {
      log('info', 'RETRY_CALLING_AGENT', { agentNumber: agentNumber, newConferenceName: newConferenceName });
      var retryStatusUrl = retryStatusBase + '?conferenceName=' + encodeURIComponent(newConferenceName) + '&agentNumber=' + encodeURIComponent(agentNumber);
      return client.calls.create({
        to: agentNumber,
        from: fromNumber,
        url: whisperUrl,
        method: 'POST',
        timeout: 25,
        statusCallback: retryStatusUrl,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST'
      }).then(function (call) {
        retryCallSids.push(call.sid);
        log('info', 'RETRY_CALL_CREATED', { agentNumber: agentNumber, agentCallSid: call.sid });
      }).catch(function (err) {
        log('error', 'RETRY_CALL_FAILED', { agentNumber: agentNumber, message: err.message });
      });
    });

    await Promise.allSettled(callPromises);

    // Store conference call SIDs in Sync for scoped cancellation
    if (syncSid && retryCallSids.length > 0) {
      try {
        await client.sync.v1.services(syncSid)
          .syncMaps(SYNC_MAP)
          .syncMapItems
          .create({ key: newConferenceName, data: { callSids: retryCallSids, agents: retryAvailable, createdAt: Date.now() }, ttl: 300 });
      } catch (storeErr) {
        log('warn', 'STORE_RETRY_CONFERENCE_CALLS_FAILED', { message: storeErr.message });
      }
    }

    // Redirect caller to join the new conference
    var joinUrl = baseUrl + '/join_conference?conferenceName=' + encodeURIComponent(newConferenceName)
      + '&callSid=' + encodeURIComponent(callSid)
      + '&callerNumber=' + encodeURIComponent(callerNumber)
      + '&calledNumber=' + encodeURIComponent(calledNumber);
    log('info', 'RETRY_REDIRECTING', { joinUrl: joinUrl });
    twiml.redirect({ method: 'POST' }, joinUrl);

    log('info', 'END', { outcome: 'retry_redirect' });
    return callback(null, twiml);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  OTHER / INVALID → GOODBYE
  // ═══════════════════════════════════════════════════════════════════
  log('info', 'INVALID_DIGIT', { digit: digit });
  twiml.say('Thank you for calling Traders Utopia. Goodbye.');
  twiml.hangup();

  log('info', 'END', { outcome: 'goodbye' });
  return callback(null, twiml);
};
