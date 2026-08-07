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
  var callerNumber = getParam(event, ['callerNumber', 'CallerNumber', 'From', 'Caller']);
  var calledNumber = getParam(event, ['calledNumber', 'CalledNumber', 'To', 'Called']);
  var callSid = getParam(event, ['callSid', 'CallSid']);

  var elapsedMs = nowMs - startedAt;
  var maxWaitMs = parseInt(context.MAX_WAIT_MS || '30000', 10);
  if (isNaN(maxWaitMs) || maxWaitMs < 1000) maxWaitMs = 30000;

  var correlation = {
    requestId: requestId,
    conferenceName: conferenceName,
    startedAt: startedAt,
    elapsedMs: elapsedMs,
    maxWaitMs: maxWaitMs,
    callerNumber: callerNumber,
    calledNumber: calledNumber,
    callSid: callSid
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
        await postMissedCallback(context, {
          callerNumber: callerNumber,
          calledNumber: calledNumber,
          callSid: callSid,
          conferenceName: conferenceName
        }, log);
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
    + '&startedAt=' + startedAt
    + '&callerNumber=' + encodeURIComponent(callerNumber)
    + '&calledNumber=' + encodeURIComponent(calledNumber)
    + '&callSid=' + encodeURIComponent(callSid);

  log('info', 'HOLD_LOOP', { outcome: 'continue_waiting', pauseSeconds: 5, selfUrl: selfUrl });
  twiml.say('Please hold while we connect you.');
  twiml.pause({ length: 5 });
  twiml.redirect({ method: 'POST' }, selfUrl);
  return callback(null, twiml);
};

function getParam(event, names) {
  event = event || {};
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (event[name] !== undefined && event[name] !== null && event[name] !== '') {
      return String(event[name]).trim();
    }
  }

  if (event.body && typeof event.body === 'object') {
    for (var j = 0; j < names.length; j++) {
      var bodyName = names[j];
      if (event.body[bodyName] !== undefined && event.body[bodyName] !== null && event.body[bodyName] !== '') {
        return String(event.body[bodyName]).trim();
      }
    }
  }

  var rawBody = (typeof event.body === 'string') ? event.body
              : (typeof event.Body === 'string') ? event.Body : '';
  if (!rawBody) return '';

  for (var k = 0; k < names.length; k++) {
    var escapedName = names[k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var match = rawBody.match(new RegExp('(?:^|&)' + escapedName + '=([^&]*)'));
    if (match) return decodeURIComponent(match[1]).trim();
  }

  return '';
}

async function postMissedCallback(context, data, log) {
  var callbackUrl = (context.CALLBACK_SCRIPT_URL || '').trim();
  if (!callbackUrl || !data.callerNumber) {
    log('warn', 'MISSED_CALLBACK_SKIPPED', {
      hasUrl: !!callbackUrl,
      hasCallerNumber: !!data.callerNumber
    });
    return;
  }

  try {
    var https = require('https');
    var postBody = JSON.stringify({
      event: 'callback_requested',
      caller: data.callerNumber,
      called_number: data.calledNumber,
      digits: 'missed_no_agent',
      call_sid: data.callSid,
      conference_name: data.conferenceName,
      timestamp: new Date().toISOString()
    });
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

    log('info', 'MISSED_CALLBACK_LOGGED', { statusCode: postResult.statusCode });
  } catch (err) {
    log('error', 'MISSED_CALLBACK_FAILED', { message: err.message });
  }
}
