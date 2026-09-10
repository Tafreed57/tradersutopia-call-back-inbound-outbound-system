/**
 * /conference_status_callback
 *
 * INVOCATION:  Twilio Conference statusCallback (POST)
 * RETURNS:     empty 200 (Twilio ignores the response body)
 *
 * PURPOSE:
 *   Persist actual agent joins and caller departures for missed-call
 *   classification, log lifecycle events, and release ended agent claims.
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

  // Persist actual joins and caller departures; never infer an answer from a timeout.
  var original = /^TU_(CA[0-9a-fA-F]{32})(?:_|$)/.exec(friendlyName);
  var agentJoined = original && eventType === 'participant-join' && participantCallSid &&
    participantCallSid !== original[1];
  var callerLeft = original && eventType === 'participant-leave' && participantCallSid === original[1];
  var deliveryError = null;
  if (original && (agentJoined || callerLeft || eventType === 'conference-end')) {
    var endpoint = (context.CALLBACK_SCRIPT_URL || '').trim();
    var body = JSON.stringify({
      event: agentJoined ? 'inbound_agent_joined' : 'inbound_ended',
      call_sid: original[1],
      conference_name: friendlyName,
      timestamp: new Date().toISOString()
    });
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        if (!endpoint) throw new Error('CALLBACK_SCRIPT_URL is missing');
        var response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
            'x-call-routing-secret': (context.CALL_ROUTING_SECRET || '').trim() },
          body: body,
          signal: AbortSignal.timeout(3500)
        });
        await response.text();
        if (!response.ok) throw new Error('Inbound event rejected: ' + response.status);
        deliveryError = null;
        break;
      } catch (error) { deliveryError = error; }
    }
    if (deliveryError) console.error('INBOUND_EVENT_FAILED', original[1], deliveryError.message);
  }

  // Release all agents for this conference when it ends
  var syncSid = (context.SYNC_SERVICE_SID || '').trim();
  if (syncSid && eventType === 'conference-end' && friendlyName) {
    try {
      var client = context.getTwilioClient();
      var confItem = await client.sync.v1.services(syncSid)
        .syncMaps('call_routing')
        .syncMapItems(friendlyName)
        .fetch();
      try {
        await client.sync.v1.services(syncSid).syncMaps('call_routing')
          .syncMapItems('winner_' + friendlyName).remove();
      } catch (winnerCleanup) {
        if (winnerCleanup.status !== 404) console.warn('WINNER_CLEANUP_FAILED', winnerCleanup.message);
      }
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

  return callback(deliveryError, '');
};
