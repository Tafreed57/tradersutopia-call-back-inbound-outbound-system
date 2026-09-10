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
      if (conferenceName && item.data.conferenceName === conferenceName &&
          (!item.data.callSid || item.data.callSid === agentCallSid)) {
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

  // Post "agent_call_ended" to BOTH GAS and Dashboard API for redundancy.
  // If either succeeds, the LIVE row gets marked ENDED. This prevents stale
  // calls from persisting if one endpoint is temporarily unreachable.
  var callbackUrl = (context.CALLBACK_SCRIPT_URL || '').trim();
  var dashboardApiUrl = ''; // The former /api/live-calls/end route does not exist.

  if (isTerminal && (callbackUrl || dashboardApiUrl)) {
    var https2 = require('https');
    var endBody = JSON.stringify({
      event: 'agent_call_ended',
      agent: agentNumber,
      conference_name: conferenceName,
      call_status: callStatus,
      call_duration: event.CallDuration || event.Duration || '0',
      sip_response_code: event.SipResponseCode || '',
      timestamp: new Date().toISOString()
    });

    function postEndEvent(targetUrl, label, timeoutMs) {
      return new Promise(function (resolve) {
        try {
          var url = new URL(targetUrl);
          var req = https2.request({
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(endBody),
              'x-call-routing-secret': (context.CALL_ROUTING_SECRET || '').trim()
            },
            timeout: timeoutMs
          }, function (res) {
            var resBody = '';
            res.on('data', function (chunk) { resBody += chunk; });
            res.on('end', function () {
              var ok = res.statusCode >= 200 && res.statusCode < 300;
              if (!ok) {
                console.log(JSON.stringify({
                  level: 'warn', fn: FN, step: label + '_HTTP_ERROR',
                  statusCode: res.statusCode, body: resBody.slice(0, 200),
                  agentNumber: agentNumber, conferenceName: conferenceName
                }));
              }
              resolve(ok);
            });
          });
          req.on('error', function (err) {
            console.log(JSON.stringify({
              level: 'warn', fn: FN, step: label + '_NETWORK_ERROR',
              message: err.message, agentNumber: agentNumber, conferenceName: conferenceName
            }));
            resolve(false);
          });
          req.on('timeout', function () {
            req.destroy();
            console.log(JSON.stringify({
              level: 'warn', fn: FN, step: label + '_TIMEOUT',
              timeoutMs: timeoutMs, agentNumber: agentNumber, conferenceName: conferenceName
            }));
            resolve(false);
          });
          req.write(endBody);
          req.end();
        } catch (err) {
          console.log(JSON.stringify({
            level: 'warn', fn: FN, step: label + '_EXCEPTION',
            message: err.message, agentNumber: agentNumber, conferenceName: conferenceName
          }));
          resolve(false);
        }
      });
    }

    var endPromises = [];
    if (callbackUrl) {
      endPromises.push(postEndEvent(callbackUrl, 'DASHBOARD_END', 3500));
    }
    if (dashboardApiUrl) {
      var apiEndUrl = dashboardApiUrl.replace(/\/+$/, '') + '/api/live-calls/end';
      endPromises.push(postEndEvent(apiEndUrl, 'DASHBOARD_END', 5000));
    }

    var endResults = await Promise.allSettled(endPromises);
    var anySucceeded = endResults.some(function (r) {
      return r.status === 'fulfilled' && r.value === true;
    });

    if (!anySucceeded && callbackUrl) {
      anySucceeded = await postEndEvent(callbackUrl, 'DASHBOARD_END_RETRY', 3500);
    }
    if (!anySucceeded && endPromises.length > 0) {
      console.log(JSON.stringify({
        level: 'error', fn: FN, step: 'ALL_END_POSTS_FAILED',
        agentNumber: agentNumber, conferenceName: conferenceName,
        callStatus: callStatus,
        message: 'LIVE row may remain stale — auto-cleanup will expire it within 2 hours'
      }));
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
