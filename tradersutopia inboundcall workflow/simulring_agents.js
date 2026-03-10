/**
 * /simulring_agents
 *
 * INVOCATION:  Twilio Studio → HTTP Request (POST) widget
 * RETURNS:     JSON  →  callback(null, { ...json })
 *
 * PURPOSE:
 *   Fire simultaneous outbound calls to all agents.
 *   Each outbound call is pointed at /agent_whisper which gates
 *   entry into the caller's conference behind a "press 1" prompt.
 *
 * REQUIRED event params (POST body):
 *   conferenceName  – e.g. "TU_CA…"
 *
 * OPTIONAL event params:
 *   callSid / CallSid – original caller's CallSid (for correlation)
 *
 * REQUIRED env vars (context):
 *   FROM_NUMBER  – Twilio voice-capable number for caller-ID
 *
 * OPTIONAL env vars:
 *   AGENT_LIST   – comma-separated E.164 numbers  (fallback: hard-coded list)
 *   BASE_URL     – override domain  (fallback: https://<DOMAIN_NAME>)
 */
exports.handler = async function (context, event, callback) {
  // ── RAW EVENT DUMP (diagnostic — check Twilio Live Logs) ───────────
  console.log("RAW_EVENT=" + JSON.stringify(event));
  console.log("DOMAIN=" + context.DOMAIN_NAME);

  // ── Correlation & logging ──────────────────────────────────────────
  var requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var FN = 'simulring_agents';

  // ── Robust conferenceName extraction ───────────────────────────────
  //    Studio POSTs form-urlencoded: conferenceName=TU_...
  //    Runtime *should* parse into event.conferenceName, but we
  //    defensively check every possible location.
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

  var callerCallSid = (event.callSid || event.CallSid || '').trim();
  var correlation = { requestId: requestId, conferenceName: conferenceName, callerCallSid: callerCallSid };

  function log(level, step, extra) {
    console.log(JSON.stringify(
      Object.assign({ level: level, fn: FN, step: step }, correlation, extra || {}, { ts: new Date().toISOString() })
    ));
  }

  log('info', 'START', {
    source: 'studio_http_post',
    rawParams: { conferenceName: event.conferenceName, callSid: event.callSid || event.CallSid },
    eventKeys: Object.keys(event || {})
  });

  // ── Validate required params ───────────────────────────────────────
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

  // ── Agent list (env-configurable, comma-separated) ─────────────────
  var agentRaw = context.AGENT_LIST || '+14375505339,+14372365634';
  var AGENTS = agentRaw.split(',').map(function (n) { return n.trim(); }).filter(Boolean);

  if (AGENTS.length === 0) {
    log('error', 'NO_AGENTS', { message: 'AGENT_LIST resolved to empty array' });
    return callback(null, { ok: false, error: 'No agents configured' });
  }

  // ── FROM number ────────────────────────────────────────────────────
  var FROM_NUMBER = (context.FROM_NUMBER || '').trim();
  if (!FROM_NUMBER) {
    log('error', 'MISSING_ENV', { missing: 'FROM_NUMBER' });
    return callback(null, { ok: false, error: 'Environment variable FROM_NUMBER is not set' });
  }

  // ── Build whisper URL ──────────────────────────────────────────────
  var baseUrl = (context.BASE_URL || ('https://' + context.DOMAIN_NAME)).replace(/\/+$/, '');
  var whisperUrl = baseUrl + '/agent_whisper?conferenceName=' + encodeURIComponent(conferenceName);
  log('info', 'CONFIG', { baseUrl: baseUrl, whisperUrl: whisperUrl, agentCount: AGENTS.length });

  // ── Atomic agent availability check ───────────────────────────────
  //    SYNC_SERVICE_SID set → Twilio Sync (atomic, zero race window)
  //    Not set → REST API fallback (small race window, functional)
  var client = context.getTwilioClient();
  var syncSid = (context.SYNC_SERVICE_SID || '').trim();
  var SYNC_MAP = 'call_routing';
  var availableAgents = [];

  if (syncSid) {
    // Ensure Sync Map exists (idempotent — 409 if already exists)
    var syncMapReady = false;
    try {
      await client.sync.v1.services(syncSid).syncMaps.create({ uniqueName: SYNC_MAP });
      syncMapReady = true;
    } catch (mapErr) {
      // 409 = map already exists (expected). Anything else = Sync is broken.
      syncMapReady = (mapErr.status === 409);
      if (!syncMapReady) {
        log('error', 'SYNC_MAP_FAILED', { message: mapErr.message, status: mapErr.status });
      }
    }

    if (syncMapReady) {
      for (var a = 0; a < AGENTS.length; a++) {
        var checkNumber = AGENTS[a];
        try {
          await client.sync.v1.services(syncSid)
            .syncMaps(SYNC_MAP)
            .syncMapItems
            .create({
              key: checkNumber,
              data: { conferenceName: conferenceName, claimedAt: Date.now() },
              ttl: 300
            });
          availableAgents.push(checkNumber);
          log('info', 'AGENT_CLAIMED', { agentNumber: checkNumber, via: 'sync' });
        } catch (claimErr) {
          if (claimErr.status === 409) {
            log('info', 'AGENT_BUSY', { agentNumber: checkNumber, via: 'sync', skipping: true });
          } else {
            // Sync error ≠ agent busy. Fail-open: dial the agent anyway.
            log('warn', 'SYNC_CLAIM_ERROR', { agentNumber: checkNumber, message: claimErr.message, status: claimErr.status });
            availableAgents.push(checkNumber);
          }
        }
      }
    } else {
      // Sync is broken — fall back to REST API so calls still go through
      log('warn', 'SYNC_UNAVAILABLE_FALLBACK', { syncSid: syncSid });
      for (var fb = 0; fb < AGENTS.length; fb++) {
        var fbNum = AGENTS[fb];
        try {
          var fbCalls = await client.calls.list({ to: fbNum, from: FROM_NUMBER, status: 'in-progress', limit: 1 });
          if (fbCalls.length > 0) {
            log('info', 'AGENT_BUSY', { agentNumber: fbNum, via: 'rest_api_fallback', activeCallSid: fbCalls[0].sid });
          } else {
            availableAgents.push(fbNum);
          }
        } catch (fbErr) {
          log('warn', 'AVAILABILITY_CHECK_FAILED', { agentNumber: fbNum, message: fbErr.message });
          availableAgents.push(fbNum);
        }
      }
    }
  } else {
    log('warn', 'NO_SYNC_SERVICE', { message: 'Set SYNC_SERVICE_SID for atomic agent claiming' });
    for (var af = 0; af < AGENTS.length; af++) {
      var checkNum = AGENTS[af];
      try {
        var busyCalls = await client.calls.list({ to: checkNum, from: FROM_NUMBER, status: 'in-progress', limit: 1 });
        if (busyCalls.length > 0) {
          log('info', 'AGENT_BUSY', { agentNumber: checkNum, via: 'rest_api', activeCallSid: busyCalls[0].sid });
        } else {
          availableAgents.push(checkNum);
        }
      } catch (checkErr) {
        log('warn', 'AVAILABILITY_CHECK_FAILED', { agentNumber: checkNum, message: checkErr.message });
        availableAgents.push(checkNum);
      }
    }
  }

  log('info', 'AVAILABILITY_RESULT', {
    totalAgents: AGENTS.length,
    availableCount: availableAgents.length,
    availableAgents: availableAgents,
    method: syncSid ? 'sync' : 'rest_api'
  });

  if (availableAgents.length === 0) {
    log('warn', 'NO_AGENTS_AVAILABLE', { totalAgents: AGENTS.length });
    return callback(null, {
      ok: true,
      conferenceName: conferenceName,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      callSids: [],
      noAgentsAvailable: true
    });
  }

  // ── Fire outbound calls to available agents only ────────────────────
  var attempted = 0;
  var succeeded = 0;
  var failed = 0;
  var callSids = [];

  try {
    var results = await Promise.allSettled(
      availableAgents.map(function (agentNumber) {
        attempted++;
        log('info', 'CALLING_AGENT', { agentNumber: agentNumber });
        var agentStatusUrl = baseUrl + '/agent_call_status?conferenceName=' + encodeURIComponent(conferenceName) + '&agentNumber=' + encodeURIComponent(agentNumber);
        return client.calls.create({
          to: agentNumber,
          from: FROM_NUMBER,
          url: whisperUrl,
          method: 'POST',
          timeout: 25,
          statusCallback: agentStatusUrl,
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          statusCallbackMethod: 'POST'
        });
      })
    );

    results.forEach(function (result, idx) {
      var agentNumber = availableAgents[idx];
      if (result.status === 'fulfilled') {
        succeeded++;
        var sid = result.value.sid;
        callSids.push(sid);
        log('info', 'CALL_CREATED', { agentNumber: agentNumber, agentCallSid: sid });
      } else {
        failed++;
        log('error', 'CALL_FAILED', {
          agentNumber: agentNumber,
          message: result.reason ? result.reason.message : String(result.reason)
        });
      }
    });
  } catch (err) {
    log('error', 'OUTBOUND_BATCH_ERROR', { message: err.message, stack: err.stack });
    return callback(null, {
      ok: false,
      error: 'Failed to create outbound calls',
      detail: err.message
    });
  }

  // ── Store conference call SIDs in Sync for scoped cancellation ─────
  if (syncSid && callSids.length > 0) {
    try {
      await client.sync.v1.services(syncSid)
        .syncMaps(SYNC_MAP)
        .syncMapItems
        .create({
          key: conferenceName,
          data: { callSids: callSids, agents: availableAgents, createdAt: Date.now() },
          ttl: 300
        });
    } catch (storeErr) {
      log('warn', 'STORE_CONFERENCE_CALLS_FAILED', { message: storeErr.message });
    }
  }

  log('info', 'END', { attempted: attempted, succeeded: succeeded, failed: failed, callSids: callSids });

  // ── JSON response for Studio ───────────────────────────────────────
  return callback(null, {
    ok: true,
    conferenceName: conferenceName,
    attempted: attempted,
    succeeded: succeeded,
    failed: failed,
    callSids: callSids
  });
};
