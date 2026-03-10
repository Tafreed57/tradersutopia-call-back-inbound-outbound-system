/**
 * /agent_whisper
 *
 * INVOCATION:  Twilio Voice webhook (POST) – the "url" on outbound agent calls
 * RETURNS:     TwiML  →  callback(null, twiml)
 *
 * PURPOSE:
 *   When an agent answers the outbound call, play a whisper prompt
 *   and Gather a single digit.  Only "1" joins the conference.
 *   Voicemail / IVR can't press 1 → call hangs up harmlessly.
 *   Decline/no-input hangs up THIS AGENT ONLY; caller and other agents unaffected.
 *   Full behavior: VOICE_FLOW.md
 *
 * VOICEMAIL FILTERING:
 *   The "press 1" Gather IS the voicemail filter. Machines can't press keys.
 *   AMD (machineDetection) is NOT used — it adds 5-7 seconds of dead air
 *   before the webhook fires, causing agents to hear silence and press
 *   digits that get lost (Gather hasn't started yet).
 *
 * RETRY:
 *   On no-input, redirects back with incremented try counter (max 2).
 *   After max retries: hangs up.
 *
 * EXPECTED event params (POST body from Twilio):
 *   conferenceName  – passed as query param on the webhook URL
 *   CallSid         – Twilio-injected SID of this agent leg
 *   Called / To      – the agent number that was dialed
 *   try             – retry counter (query param, default 0)
 */
exports.handler = function (context, event, callback) {
  var entryMs = Date.now();
  var requestId = 'req_' + entryMs + '_' + Math.random().toString(36).slice(2, 8);
  var FN = 'agent_whisper';

  // Robust conferenceName extraction
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

  var agentCallSid = (event.CallSid || '').trim();
  var agentNumber = (event.Called || event.To || '').trim();
  var tryCount = parseInt(event.try || event.Try || '0', 10) || 0;
  var MAX_TRIES = 2;

  var correlation = { requestId: requestId, conferenceName: conferenceName, agentCallSid: agentCallSid, agentNumber: agentNumber, try: tryCount };

  function log(level, step, extra) {
    console.log(JSON.stringify(
      Object.assign({ level: level, fn: FN, step: step }, correlation, extra || {}, { ts: new Date().toISOString() })
    ));
  }

  log('info', 'START', { source: 'voice_webhook', eventKeys: Object.keys(event || {}) });

  var twiml = new Twilio.twiml.VoiceResponse();

  if (!conferenceName) {
    log('warn', 'MISSING_PARAM', { missing: 'conferenceName' });
    twiml.say('System error. Goodbye.');
    twiml.hangup();
    return callback(null, twiml);
  }

  // Build action URL for Gather
  var baseUrl = (context.BASE_URL || ('https://' + context.DOMAIN_NAME)).replace(/\/+$/, '');
  var acceptUrl = baseUrl + '/agent_whisper_accept?conferenceName=' + encodeURIComponent(conferenceName);

  // Gather: press 1 to accept (barge-in enabled by default — digits during Say are captured)
  var gather = twiml.gather({
    numDigits: 1,
    timeout: 8,
    action: acceptUrl,
    method: 'POST',
    input: 'dtmf'
  });

  if (tryCount === 0) {
    gather.say('Traders Utopia incoming call. Press 1 to accept.');
  } else {
    gather.say('Press 1 to accept the call.');
  }

  // No-input path: retry or hang up
  if (tryCount < MAX_TRIES) {
    var retryUrl = baseUrl + '/agent_whisper?conferenceName=' + encodeURIComponent(conferenceName) + '&try=' + (tryCount + 1);
    twiml.say('No input received.');
    twiml.redirect({ method: 'POST' }, retryUrl);
  } else {
    twiml.say('No response received. Goodbye.');
    twiml.hangup();
  }

  var elapsedMs = Date.now() - entryMs;
  log('info', 'END', { outcome: 'whisper_played', elapsedMs: elapsedMs });
  return callback(null, twiml);
};
