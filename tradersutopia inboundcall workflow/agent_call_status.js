/**
 * /agent_call_status
 *
 * INVOCATION:  Twilio Call statusCallback (POST)
 * RETURNS:     empty 200 (Twilio ignores the response body)
 *
 * PURPOSE:
 *   Log agent call lifecycle events (initiated, ringing, answered, completed)
 *   for debugging mid-call disconnects.  Captures who hung up and why.
 *   When an agent's call ends (e.g. they tap "Decline" on their phone), we only
 *   release that agent from Sync — we never end the conference, hang up the
 *   caller, or cancel other agents' rings.  Full behavior: VOICE_FLOW.md
 *
 * KEY FIELDS FROM TWILIO:
 *   CallSid, CallStatus, CallDuration, Duration,
 *   SipResponseCode, ErrorCode, ErrorMessage
 *
 * OPTIONAL env:
 *   DEBUG_WEBHOOK_URL – external webhook to forward events to (e.g. webhook.site)
 */
exports.handler = async function (context, event, callback) {
  var FN = 'agent_call_status';
  var callStatus = event.CallStatus || '';
  var agentCallSid = event.CallSid || '';
  var conferenceName = event.conferenceName || event.ConferenceName || '';
  var agentNumber = event.agentNumber || event.To || event.Called || '';

  var payload = {
    level: 'info',
    fn: FN,
    event: callStatus,
    agentCallSid: agentCallSid,
    agentNumber: agentNumber,
    conferenceName: conferenceName,
    ts: new Date().toISOString()
  };

  var TERMINAL_STATUSES = ['completed', 'no-answer', 'busy', 'failed', 'canceled'];
  var isTerminal = TERMINAL_STATUSES.indexOf(callStatus) !== -1;

  if (isTerminal) {
    payload.callDuration = event.CallDuration || event.Duration || '';
    payload.sipResponseCode = event.SipResponseCode || '';
    payload.errorCode = event.ErrorCode || '';
    payload.errorMessage = event.ErrorMessage || '';
  }

  // Release agent from Sync when their call reaches a terminal state
  var syncSid = (context.SYNC_SERVICE_SID || '').trim();
  if (syncSid && isTerminal && agentNumber) {
    try {
      var client = context.getTwilioClient();
      var item = await client.sync.v1.services(syncSid)
        .syncMaps('call_routing')
        .syncMapItems(agentNumber)
        .fetch();
      if (!conferenceName || item.data.conferenceName === conferenceName) {
        await client.sync.v1.services(syncSid)
          .syncMaps('call_routing')
          .syncMapItems(agentNumber)
          .remove();
        payload.agentReleased = true;
      }
    } catch (releaseErr) {
      if (releaseErr.status !== 404) {
        payload.syncReleaseError = { message: releaseErr.message, status: releaseErr.status };
      }
    }
  }

  console.log(JSON.stringify(payload));

  // Post "agent_call_ended" to callback dashboard when agent call ends
  var callbackUrl = (context.CALLBACK_SCRIPT_URL || '').trim();
  if (callbackUrl && isTerminal) {
    try {
      var https2 = require('https');
      var dashBody = JSON.stringify({
        event: 'agent_call_ended',
        agent: agentNumber,
        conference_name: conferenceName,
        call_status: callStatus,
        call_duration: event.CallDuration || event.Duration || '0',
        sip_response_code: event.SipResponseCode || '',
        timestamp: new Date().toISOString()
      });
      var dashUrl = new URL(callbackUrl);
      await new Promise(function (resolve) {
        var req = https2.request({
          hostname: dashUrl.hostname,
          port: dashUrl.port || 443,
          path: dashUrl.pathname + dashUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(dashBody)
          },
          timeout: 5000
        }, function (res) {
          res.on('data', function () {});
          res.on('end', function () { resolve(); });
        });
        req.on('error', function () { resolve(); });
        req.on('timeout', function () { req.destroy(); resolve(); });
        req.write(dashBody);
        req.end();
      });
    } catch (dashErr) {
      console.log(JSON.stringify({ level: 'warn', fn: FN, step: 'DASHBOARD_END_FAILED', message: dashErr.message }));
    }
  }

  var debugUrl = (context.DEBUG_WEBHOOK_URL || '').trim();
  if (debugUrl) {
    try {
      var https = require('https');
      var postBody = JSON.stringify(payload);
      var url = new URL(debugUrl);
      await new Promise(function (resolve) {
        var req = https.request({
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postBody)
          },
          timeout: 3000
        }, function (res) {
          res.on('data', function () {});
          res.on('end', function () { resolve(); });
        });
        req.on('error', function () { resolve(); });
        req.on('timeout', function () { req.destroy(); resolve(); });
        req.write(postBody);
        req.end();
      });
    } catch (e) {}
  }

  return callback(null, '');
};
