/**
 * /join_conference
 *
 * INVOCATION:  Twilio Voice webhook (POST) – from Studio "TwiML Redirect" widget
 * RETURNS:     TwiML  →  callback(null, twiml)
 *
 * PURPOSE:
 *   Place the caller into the named conference.  This is how the caller
 *   gets "parked" while agents are being rung via /simulring_agents.
 *   Caller only leaves hold when an agent joins or waitUrl timeout; one agent
 *   declining does not affect the caller.  Full behavior: VOICE_FLOW.md
 *
 *   CRITICAL:  Studio MUST invoke this via a "TwiML Redirect" widget,
 *   NOT an "HTTP Request" widget.  TwiML Redirect hands control of the
 *   voice leg to the TwiML returned here; HTTP Request only reads JSON.
 *
 * STUDIO WIDGET CONFIGURATION:
 *   Widget type:  TwiML Redirect
 *   URL:          https://{{DOMAIN}}/join_conference?conferenceName={{flow.variables.conferenceName}}
 *   Method:       POST
 *
 * EXPECTED event params (POST body / query params from Twilio):
 *   conferenceName  – e.g. "TU_CA…"  (passed as query param above)
 *   CallSid         – Twilio-injected SID of the caller's leg
 *
 * CONFERENCE BEHAVIOUR:
 *   - startConferenceOnEnter: true  → conference goes "in-progress" immediately
 *     so /check_conference can find it
 *   - endConferenceOnExit: true     → if caller hangs up, conference ends
 *   - waitUrl: /conference_wait (self-loop until timeout, then ends conference)
 *
 * POST-CONFERENCE:
 *   When <Dial> completes (timeout or agent hangup), the TwiML plays a
 *   <Gather> menu: press 1 for callback, press 2 to try again.
 *   This is handled entirely in Functions — we do NOT redirect to Studio
 *   because Studio returns HTTP 400 when you redirect back to a Flow
 *   that already has an active execution for the same call.
 */
exports.handler = function (context, event, callback) {
  // ── RAW EVENT DUMP (diagnostic — check Twilio Live Logs) ───────────
  console.log("JOIN_CONF_RAW_EVENT=" + JSON.stringify(event));
  console.log("JOIN_CONF_DOMAIN=" + context.DOMAIN_NAME);

  // ── Correlation & logging ──────────────────────────────────────────
  var requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // ── Robust conferenceName extraction ───────────────────────────────
  //    TwiML Redirect sends ?conferenceName=... as query param.
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
  console.log("JOIN_CONF_PARSED_conferenceName=" + conferenceName);

  var callSid = (event.CallSid || '').trim();
  var callerNumber = (event.From || event.Caller || '').trim();
  var calledNumber = (event.To || event.Called || '').trim();
  var correlation = { requestId: requestId, conferenceName: conferenceName, callSid: callSid };
  var FN = 'join_conference';

  function log(level, step, extra) {
    console.log(JSON.stringify(
      Object.assign({ level: level, fn: FN, step: step }, correlation, extra || {}, { ts: new Date().toISOString() })
    ));
  }

  log('info', 'START', {
    source: 'voice_webhook',
    callerNumber: callerNumber,
    eventKeys: Object.keys(event || {})
  });

  var twiml = new Twilio.twiml.VoiceResponse();

  // ── Validate ───────────────────────────────────────────────────────
  if (!conferenceName) {
    log('warn', 'MISSING_PARAM', { missing: 'conferenceName' });
    twiml.say('Conference name missing. Goodbye.');
    twiml.hangup();
    log('info', 'END', { outcome: 'error_missing_param' });
    return callback(null, twiml);
  }

  // ── Build waitUrl for conference timeout escape ────────────────────
  //    Twilio calls this while caller is alone; after MAX_WAIT_MS the
  //    waitUrl ends the conference via REST API, <Dial> completes, and
  //    the post-Dial <Gather> below plays.
  var baseUrl = (context.BASE_URL || ('https://' + context.DOMAIN_NAME)).replace(/\/+$/, '');
  var startedAt = Date.now();
  var waitUrl = baseUrl + '/conference_wait?conferenceName=' + encodeURIComponent(conferenceName) + '&startedAt=' + startedAt;

  log('info', 'PARKING_CALLER', {
    conferenceName: conferenceName,
    callSid: callSid,
    startConferenceOnEnter: true,
    endConferenceOnExit: true,
    waitUrl: waitUrl,
    startedAt: startedAt
  });

  var statusCallbackUrl = baseUrl + '/conference_status_callback';

  var dial = twiml.dial();
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      beep: false,
      waitUrl: waitUrl,
      waitMethod: 'POST',
      statusCallback: statusCallbackUrl,
      statusCallbackEvent: 'start end join leave',
      statusCallbackMethod: 'POST'
    },
    conferenceName
  );

  // ── Post-conference menu ───────────────────────────────────────────
  //    When conference ends for ANY reason:
  //      - Agent hangs up (endConferenceOnExit: true on agent leg)
  //      - Timeout (conference_wait ends conference via REST API)
  //      - Caller was last participant
  //    <Dial> completes and Twilio runs the verbs below.
  //
  //    We handle the menu directly in Functions because Studio returns
  //    HTTP 400 when you redirect back to a Flow with an active execution.
  var actionUrl = baseUrl + '/timeout_action'
    + '?callerNumber=' + encodeURIComponent(callerNumber)
    + '&calledNumber=' + encodeURIComponent(calledNumber)
    + '&callSid=' + encodeURIComponent(callSid);

  log('info', 'POST_CONFERENCE_GATHER', { actionUrl: actionUrl });

  var gather = twiml.gather({
    numDigits: 1,
    timeout: 10,
    action: actionUrl,
    method: 'POST'
  });
  gather.say('If you need further assistance, press 1 to request a callback, or press 2 to speak with another agent.');

  // No input → thank you and hangup
  twiml.say('Thank you for calling Traders Utopia. Goodbye.');
  twiml.hangup();

  log('info', 'END', { outcome: 'twiml_conference_with_gather' });
  return callback(null, twiml);
};
