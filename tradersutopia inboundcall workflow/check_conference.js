/**
 * /check_conference
 *
 * INVOCATION:  Twilio Studio → HTTP Request (POST) widget
 * RETURNS:     JSON  →  callback(null, { ...json })
 *
 * PURPOSE:
 *   Let Studio poll whether an agent has joined the caller's conference.
 *   Studio loops: call /check_conference → inspect agentJoined →
 *     if true  → success path
 *     if false → pause → retry (up to N attempts)
 *
 * REQUIRED event params (POST body):
 *   conferenceName  – e.g. "TU_CA…"
 *
 * RESPONSE shape:
 *   { ok: true,  agentJoined: bool, participantCount: int, conferenceSid: string|null, reason?: string }
 *   { ok: false, error: string, detail?: string }
 */
exports.handler = async function (context, event, callback) {
  // ── RAW EVENT DUMP (diagnostic — check Twilio Live Logs) ───────────
  console.log("RAW_EVENT=" + JSON.stringify(event));
  console.log("DOMAIN=" + context.DOMAIN_NAME);

  // ── Correlation & logging ──────────────────────────────────────────
  var requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var FN = 'check_conference';

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
      var bodyMatch = rawBody.match(/conferenceName=([^&]+)/);
      if (bodyMatch) conferenceName = decodeURIComponent(bodyMatch[1]);
    }
  }
  conferenceName = (conferenceName || '').trim();
  console.log("PARSED_conferenceName=" + conferenceName);

  var correlation = { requestId: requestId, conferenceName: conferenceName };

  function log(level, step, extra) {
    console.log(JSON.stringify(
      Object.assign({ level: level, fn: FN, step: step }, correlation, extra || {}, { ts: new Date().toISOString() })
    ));
  }

  log('info', 'START', { source: 'studio_http_post', eventKeys: Object.keys(event || {}) });

  // ── Validate ───────────────────────────────────────────────────────
  if (!conferenceName) {
    log('warn', 'MISSING_PARAM', { missing: 'conferenceName', receivedKeys: Object.keys(event || {}) });
    return callback(null, {
      ok: false,
      error: 'Missing required param: conferenceName',
      receivedKeys: Object.keys(event || {}),
      bodyPreview: typeof event.body === 'string' ? event.body.substring(0, 200)
                 : typeof event.Body === 'string' ? event.Body.substring(0, 200) : null
    });
  }

  try {
    var client = context.getTwilioClient();

    // ── Find in-progress conference by friendly name ─────────────────
    var confs = await client.conferences.list({
      friendlyName: conferenceName,
      status: 'in-progress',
      limit: 1
    });

    if (confs.length === 0) {
      log('info', 'NO_ACTIVE_CONFERENCE', { reason: 'no in-progress conference with this name' });
      return callback(null, {
        ok: true,
        agentJoined: false,
        participantCount: 0,
        conferenceSid: null,
        reason: 'no_active_conference'
      });
    }

    var conf = confs[0];

    // ── List participants ────────────────────────────────────────────
    var participants = await client.conferences(conf.sid).participants.list({ limit: 20 });
    var participantSids = participants.map(function (p) { return p.callSid; });

    // 1 participant = caller only.  2+ = at least one agent joined.
    var agentJoined = participants.length >= 2;

    log('info', 'CONFERENCE_STATE', {
      conferenceSid: conf.sid,
      participantCount: participants.length,
      participantCallSids: participantSids,
      agentJoined: agentJoined
    });

    log('info', 'END', { agentJoined: agentJoined });

    return callback(null, {
      ok: true,
      agentJoined: agentJoined,
      participantCount: participants.length,
      conferenceSid: conf.sid
    });

  } catch (err) {
    log('error', 'ERROR', { message: err.message, stack: err.stack });
    return callback(null, {
      ok: false,
      error: 'Conference check failed',
      detail: err.message
    });
  }
};
