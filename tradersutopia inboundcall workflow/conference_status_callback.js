/**
 * /conference_status_callback
 *
 * INVOCATION:  Twilio Conference statusCallback (POST)
 * RETURNS:     empty 200 (Twilio ignores the response body)
 *
 * PURPOSE:
 *   Log every conference lifecycle event so mid-call disconnects are
 *   traceable.  This function does NOT affect call behavior — it is
 *   purely observability.
 *
 * EVENTS RECEIVED (configured via statusCallbackEvent on <Conference>):
 *   participant-join, participant-leave, conference-end,
 *   conference-start
 *
 * KEY FIELDS FROM TWILIO:
 *   ConferenceSid, FriendlyName, StatusCallbackEvent,
 *   CallSid (participant), Muted, Hold, EndConferenceOnExit,
 *   StartConferenceOnEnter, Coaching, CallSidEndingConference,
 *   ReasonConferenceEnded, ReasonParticipantLeft, SequenceNumber
 *
 * OPTIONAL env:
 *   DEBUG_WEBHOOK_URL – external webhook to forward events to (e.g. webhook.site)
 */
exports.handler = async function (context, event, callback) {
  var FN = 'conference_status_callback';
  var eventType = event.StatusCallbackEvent || event.statusCallbackEvent || 'unknown';
  var conferenceSid = event.ConferenceSid || '';
  var friendlyName = event.FriendlyName || '';
  var participantCallSid = event.CallSid || '';
  var sequenceNumber = event.SequenceNumber || '';

  var payload = {
    level: 'info',
    fn: FN,
    event: eventType,
    conferenceSid: conferenceSid,
    conferenceName: friendlyName,
    participantCallSid: participantCallSid,
    sequenceNumber: sequenceNumber,
    ts: new Date().toISOString()
  };

  if (eventType === 'conference-end') {
    payload.reasonConferenceEnded = event.ReasonConferenceEnded || '';
    payload.callSidEndingConference = event.CallSidEndingConference || '';
  }

  if (eventType === 'participant-leave') {
    payload.reasonParticipantLeft = event.ReasonParticipantLeft || '';
    payload.endConferenceOnExit = event.EndConferenceOnExit || '';
  }

  if (eventType === 'participant-join') {
    payload.endConferenceOnExit = event.EndConferenceOnExit || '';
    payload.startConferenceOnEnter = event.StartConferenceOnEnter || '';
  }

  console.log(JSON.stringify(payload));

  // Release all agents for this conference when it ends
  var syncSid = (context.SYNC_SERVICE_SID || '').trim();
  if (syncSid && eventType === 'conference-end' && friendlyName) {
    try {
      var client = context.getTwilioClient();
      var confItem = await client.sync.v1.services(syncSid)
        .syncMaps('call_routing')
        .syncMapItems(friendlyName)
        .fetch();
      var agentsToRelease = confItem.data.agents || [];
      for (var r = 0; r < agentsToRelease.length; r++) {
        try {
          var agentItem = await client.sync.v1.services(syncSid)
            .syncMaps('call_routing')
            .syncMapItems(agentsToRelease[r])
            .fetch();
          if (agentItem.data.conferenceName === friendlyName) {
            await client.sync.v1.services(syncSid)
              .syncMaps('call_routing')
              .syncMapItems(agentsToRelease[r])
              .remove();
          }
        } catch (agentReleaseErr) {
          if (agentReleaseErr.status !== 404) {
            console.log(JSON.stringify({ level: 'warn', fn: FN, step: 'SYNC_AGENT_RELEASE_ERROR', agent: agentsToRelease[r], message: agentReleaseErr.message, status: agentReleaseErr.status }));
          }
        }
      }
      // Remove the conference tracking item
      await client.sync.v1.services(syncSid)
        .syncMaps('call_routing')
        .syncMapItems(friendlyName)
        .remove();
      console.log(JSON.stringify({ level: 'info', fn: FN, step: 'SYNC_CLEANUP', conferenceName: friendlyName, agentsReleased: agentsToRelease.length }));
    } catch (cleanupErr) {
      if (cleanupErr.status !== 404) {
        console.log(JSON.stringify({ level: 'warn', fn: FN, step: 'SYNC_CLEANUP_ERROR', conferenceName: friendlyName, message: cleanupErr.message, status: cleanupErr.status }));
      }
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
