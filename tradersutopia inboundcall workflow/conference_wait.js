/**
 * /conference_wait
 *
 * INVOCATION:  Twilio Voice webhook (POST) – called as Conference waitUrl
 *              and re-invoked via self-redirect while caller is alone.
 * RETURNS:     TwiML  →  callback(null, twiml)
 *
 * PURPOSE:
 *   While the caller is alone in the conference (no agent yet), this
 *   loops: Say "please hold" → Pause 5s → Redirect to self.
 *   After MAX_WAIT_MS, uses the REST API to END THE CONFERENCE.
 *   When the conference ends, the <Dial> in /join_conference completes,
 *   the post-Dial TwiML executes (<Say> then <Redirect> to Studio),
 *   and Studio picks up at the "Return" transition on the TwiML
 *   Redirect widget — which should be wired to gather_2.
 *
 *   WHY END CONFERENCE VIA REST API:
 *   - <Leave/> only works for Queues (<Enqueue>), NOT Conferences.
 *     It silently does nothing in a conference waitUrl context.
 *   - <Redirect> to Studio from waitUrl → "application error"
 *   - REST API calls.update() to Studio → HTTP 400
 *   - Ending the conference via REST API is clean: it terminates the
 *     conference, <Dial> completes, and post-Dial TwiML runs normally.
 *
 * EXPECTED event params (query / POST body):
 *   conferenceName  – robust parsing
 *   startedAt       – ms timestamp when caller joined
 *
 * OPTIONAL env:  MAX_WAIT_MS (default 30000)
 */
exports.handler = async function (context, event, callback) {
  var nowMs = Date.now();
  var requestId = 'req_' + nowMs + '_' + Math.random().toString(36).slice(2, 8);
  var FN = 'conference_wait';

  // ── Robust conferenceName extraction ───────────────────────────────
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
      var cnMatch = rawBody.match(/conferenceName=([^&]+)/);
      if (cnMatch) conferenceName = decodeURIComponent(cnMatch[1]);
    }
  }
  conferenceName = (conferenceName || '').trim();

  // ── Robust startedAt extraction ────────────────────────────────────
  var startedAtParam = event.startedAt || event.StartedAt || '';
  if (!startedAtParam && event.body && typeof event.body === 'object') {
    startedAtParam = event.body.startedAt || event.body.StartedAt || '';
  }
  if (!startedAtParam) {
    var rawBodySA = (typeof event.body === 'string') ? event.body
                  : (typeof event.Body === 'string') ? event.Body : '';
    if (rawBodySA) {
      var saMatch = rawBodySA.match(/startedAt=(\d+)/);
      if (saMatch) startedAtParam = saMatch[1];
    }
  }
  var startedAt = parseInt(startedAtParam, 10);
  if (isNaN(startedAt) || startedAt <= 0) startedAt = nowMs;

  var elapsedMs = nowMs - startedAt;
  var maxWaitMs = parseInt(context.MAX_WAIT_MS || '30000', 10);
  if (isNaN(maxWaitMs) || maxWaitMs < 1000) maxWaitMs = 30000;

  var correlation = {
    requestId: requestId,
    conferenceName: conferenceName,
    startedAt: startedAt,
    elapsedMs: elapsedMs,
    maxWaitMs: maxWaitMs
  };

  function log(level, step, extra) {
    console.log(JSON.stringify(
      Object.assign({ level: level, fn: FN, step: step }, correlation, extra || {}, { ts: new Date().toISOString() })
    ));
  }

  log('info', 'START', { eventKeys: Object.keys(event || {}) });

  var twiml = new Twilio.twiml.VoiceResponse();
  var baseUrl = (context.BASE_URL || ('https://' + context.DOMAIN_NAME)).replace(/\/+$/, '');

  if (!conferenceName) {
    log('warn', 'MISSING_PARAM', { missing: 'conferenceName', outcome: 'error_missing_param' });
    twiml.say('Conference error. Goodbye.');
    twiml.hangup();
    return callback(null, twiml);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  TIMEOUT — But ONLY if caller is still alone in the conference.
  //  Check participant count first; if an agent has joined, don't kill it.
  // ═══════════════════════════════════════════════════════════════════
  if (elapsedMs >= maxWaitMs) {
    try {
      var client = context.getTwilioClient();

      var conferences = await client.conferences.list({
        friendlyName: conferenceName,
        status: 'in-progress',
        limit: 1
      });

      if (conferences.length > 0) {
        var confSid = conferences[0].sid;
        var participants = await client.conferences(confSid).participants.list({ limit: 10 });

        if (participants.length > 1) {
          // Agent has joined — do NOT end the conference. Just play silence and stop looping.
          log('info', 'TIMEOUT_SKIPPED_AGENT_PRESENT', { conferenceSid: confSid, participantCount: participants.length });
          twiml.pause({ length: 30 });
          return callback(null, twiml);
        }

        // Caller is alone — safe to end
        log('info', 'TIMEOUT_ENDING_CONFERENCE', { conferenceSid: confSid, participantCount: participants.length });
        await client.conferences(confSid).update({ status: 'completed' });
        log('info', 'TIMEOUT_CONFERENCE_ENDED', { conferenceSid: confSid });
      } else {
        log('warn', 'TIMEOUT_NO_CONFERENCE_FOUND', { conferenceName: conferenceName });
      }
    } catch (err) {
      log('error', 'TIMEOUT_END_FAILED', { message: err.message, stack: err.stack });
    }

    twiml.say('Redirecting you now.');
    twiml.pause({ length: 2 });
    return callback(null, twiml);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HOLD LOOP — Say hold, Pause, Redirect to self
  // ═══════════════════════════════════════════════════════════════════
  var selfUrl = baseUrl + '/conference_wait'
    + '?conferenceName=' + encodeURIComponent(conferenceName)
    + '&startedAt=' + startedAt;

  log('info', 'HOLD_LOOP', { outcome: 'continue_waiting', pauseSeconds: 5, selfUrl: selfUrl });
  twiml.say('Please hold while we connect you.');
  twiml.pause({ length: 5 });
  twiml.redirect({ method: 'POST' }, selfUrl);
  return callback(null, twiml);
};
