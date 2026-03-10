#!/usr/bin/env node
/**
 * Local test harness for Twilio Functions
 *
 * Run:  node test_harness.js
 *
 * Simulates calling each handler with mock context/event objects
 * and prints the TwiML or JSON output.  Catches syntax and runtime
 * errors BEFORE you paste back into Twilio Console.
 *
 * Requirements:  npm install twilio   (only needed for this harness)
 */

/* ──────────────────────────────────────────────────────────────────── */
/*  Polyfill the global Twilio object that Twilio Functions runtime    */
/*  provides automatically.  We pull it from the twilio npm package.   */
/* ──────────────────────────────────────────────────────────────────── */
try {
  var twilio = require('twilio');
  global.Twilio = twilio;
} catch (e) {
  console.error('ERROR: "twilio" npm package not found.');
  console.error('Run:  npm install twilio');
  process.exit(1);
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Mock helpers                                                       */
/* ──────────────────────────────────────────────────────────────────── */

function createMockContext(overrides) {
  var base = {
    DOMAIN_NAME: 'tu-voice-routing-3166.twil.io',
    FROM_NUMBER: '+18005551234',
    AGENT_LIST: '+14375505339,+14372365634',
    BASE_URL: 'https://tu-voice-routing-3166.twil.io',
    getTwilioClient: function () {
      return {
        calls: {
          create: function (params) {
            console.log('    [MOCK] calls.create -> to=' + params.to + ', timeout=' + params.timeout + ', machineDetection=' + params.machineDetection);
            return Promise.resolve({ sid: 'CAmock_' + params.to.replace(/\+/g, '') });
          },
          list: function (params) {
            console.log('    [MOCK] calls.list -> status=' + params.status + ', from=' + params.from);
            return Promise.resolve([]);
          }
        },
        conferences: Object.assign(
          function (sid) {
            return {
              participants: {
                list: function () {
                  console.log('    [MOCK] conferences(' + sid + ').participants.list');
                  return Promise.resolve([
                    { callSid: 'CA_caller_mock_001' },
                    { callSid: 'CA_agent_mock_002' }
                  ]);
                }
              },
              update: function (params) {
                console.log('    [MOCK] conferences(' + sid + ').update -> status=' + params.status);
                return Promise.resolve({});
              }
            };
          },
          {
            list: function (params) {
              console.log('    [MOCK] conferences.list -> friendlyName=' + params.friendlyName + ', status=' + params.status);
              return Promise.resolve([{ sid: 'CFmock_sid_001' }]);
            }
          }
        )
      };
    }
  };
  return Object.assign(base, overrides || {});
}

function formatResult(result) {
  if (result && typeof result === 'object' && typeof result.toString === 'function') {
    var str = result.toString();
    if (str.indexOf('<?xml') === 0) {
      return 'TwiML:\n' + str;
    }
  }
  return 'JSON:\n' + JSON.stringify(result, null, 2);
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Test runner                                                        */
/* ──────────────────────────────────────────────────────────────────── */
var passCount = 0;
var failCount = 0;

function runTest(label, handlerPath, event, contextOverrides) {
  return new Promise(function (resolve) {
    console.log('\n' + '='.repeat(70));
    console.log('TEST: ' + label);
    console.log('='.repeat(70));

    try {
      // Clear require cache so each test gets a fresh module
      delete require.cache[require.resolve(handlerPath)];
      var mod = require(handlerPath);
      var ctx = createMockContext(contextOverrides);

      var cbCalled = false;
      var callbackFn = function (err, result) {
        cbCalled = true;
        if (err) {
          console.log('  CALLBACK ERROR: ' + err);
          failCount++;
        } else {
          console.log('  RESULT: ' + formatResult(result));
          passCount++;
        }
        resolve();
      };

      var maybePromise = mod.handler(ctx, event || {}, callbackFn);

      // Handle async handlers
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(function () {
          if (!cbCalled) {
            console.log('  WARNING: async handler resolved but callback was never called!');
            failCount++;
            resolve();
          }
        }).catch(function (e) {
          console.log('  UNCAUGHT ASYNC ERROR: ' + e.message);
          console.log('  Stack: ' + e.stack);
          failCount++;
          resolve();
        });
      } else {
        // Sync handler — callback should have been called synchronously
        if (!cbCalled) {
          console.log('  WARNING: sync handler returned but callback was never called!');
          failCount++;
          resolve();
        }
      }
    } catch (e) {
      console.log('  CRASH (require or handler threw): ' + e.message);
      console.log('  Stack: ' + e.stack);
      failCount++;
      resolve();
    }
  });
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Test suite                                                         */
/* ──────────────────────────────────────────────────────────────────── */
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  Twilio Functions — Local Test Harness                          ║');
  console.log('║  Tests each handler with mock context/event                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  var CONF = 'TU_CAmockCallSid12345';

  // ── simulring_agents ───────────────────────────────────────────────
  await runTest(
    'simulring_agents — happy path (Studio POST)',
    './simulring_agents',
    { conferenceName: CONF, callSid: 'CAmockCaller001' }
  );
  await runTest(
    'simulring_agents — missing conferenceName',
    './simulring_agents',
    {}
  );
  await runTest(
    'simulring_agents — missing FROM_NUMBER env',
    './simulring_agents',
    { conferenceName: CONF },
    { FROM_NUMBER: '' }
  );

  // ── agent_whisper ──────────────────────────────────────────────────
  await runTest(
    'agent_whisper — happy path (human answers)',
    './agent_whisper',
    { conferenceName: CONF, CallSid: 'CAagent001', Called: '+14375505339', AnsweredBy: 'human' }
  );
  await runTest(
    'agent_whisper — machine_start (should HANGUP)',
    './agent_whisper',
    { conferenceName: CONF, CallSid: 'CAagent001', Called: '+14375505339', AnsweredBy: 'machine_start' }
  );
  await runTest(
    'agent_whisper — machine_end_beep (should HANGUP)',
    './agent_whisper',
    { conferenceName: CONF, CallSid: 'CAagent001', Called: '+14375505339', AnsweredBy: 'machine_end_beep' }
  );
  await runTest(
    'agent_whisper — fax (should HANGUP)',
    './agent_whisper',
    { conferenceName: CONF, CallSid: 'CAagent001', Called: '+14375505339', AnsweredBy: 'fax' }
  );
  await runTest(
    'agent_whisper — unknown (should PROCEED to Gather)',
    './agent_whisper',
    { conferenceName: CONF, CallSid: 'CAagent001', Called: '+14375505339', AnsweredBy: 'unknown' }
  );
  await runTest(
    'agent_whisper — empty string (should PROCEED to Gather)',
    './agent_whisper',
    { conferenceName: CONF, CallSid: 'CAagent001', Called: '+14375505339', AnsweredBy: '' }
  );
  await runTest(
    'agent_whisper — no AnsweredBy key at all (should PROCEED to Gather)',
    './agent_whisper',
    { conferenceName: CONF, CallSid: 'CAagent002', Called: '+14372365634' }
  );
  await runTest(
    'agent_whisper — missing conferenceName',
    './agent_whisper',
    { CallSid: 'CAagent001' }
  );

  // ── agent_whisper_accept ───────────────────────────────────────────
  await runTest(
    'agent_whisper_accept — press 1 (accept)',
    './agent_whisper_accept',
    { conferenceName: CONF, Digits: '1', CallSid: 'CAagent001', Called: '+14375505339' }
  );
  await runTest(
    'agent_whisper_accept — press 5 (reject)',
    './agent_whisper_accept',
    { conferenceName: CONF, Digits: '5', CallSid: 'CAagent001', Called: '+14375505339' }
  );
  await runTest(
    'agent_whisper_accept — no digit (timeout)',
    './agent_whisper_accept',
    { conferenceName: CONF, Digits: '', CallSid: 'CAagent001' }
  );
  await runTest(
    'agent_whisper_accept — missing conferenceName',
    './agent_whisper_accept',
    { Digits: '1' }
  );

  // ── join_conference ────────────────────────────────────────────────
  await runTest(
    'join_conference — happy path',
    './join_conference',
    { conferenceName: CONF, CallSid: 'CAmockCaller001' }
  );
  await runTest(
    'join_conference — missing conferenceName',
    './join_conference',
    {}
  );

  // ── check_conference ───────────────────────────────────────────────
  await runTest(
    'check_conference — happy path (agent joined)',
    './check_conference',
    { conferenceName: CONF }
  );
  await runTest(
    'check_conference — missing conferenceName',
    './check_conference',
    {}
  );

  // ── end_conference ─────────────────────────────────────────────────
  await runTest(
    'end_conference — happy path',
    './end_conference',
    { conferenceName: CONF }
  );
  await runTest(
    'end_conference — missing conferenceName',
    './end_conference',
    {}
  );

  // ── timeout_action ────────────────────────────────────────────────
  await runTest(
    'timeout_action — digit 1 (callback, no script URL)',
    './timeout_action',
    { Digits: '1', callSid: 'CAmockCaller001', callerNumber: '+16398403191', CallSid: 'CAmockCaller001', From: '+16398403191' }
  );
  await runTest(
    'timeout_action — digit 2 (retry agents)',
    './timeout_action',
    { Digits: '2', callSid: 'CAmockCaller001', callerNumber: '+16398403191', CallSid: 'CAmockCaller001', From: '+16398403191' }
  );
  await runTest(
    'timeout_action — digit 9 (invalid)',
    './timeout_action',
    { Digits: '9', CallSid: 'CAmockCaller001' }
  );

  // ── pause_then_check ───────────────────────────────────────────────
  await runTest(
    'pause_then_check — happy path (5s pause)',
    './pause_then_check',
    { conferenceName: CONF, seconds: '5', attempt: '2' }
  );
  await runTest(
    'pause_then_check — missing conferenceName',
    './pause_then_check',
    {}
  );
  await runTest(
    'pause_then_check — extreme seconds clamped',
    './pause_then_check',
    { conferenceName: CONF, seconds: '999' }
  );

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('RESULTS:  ' + passCount + ' passed,  ' + failCount + ' failed');
  console.log('='.repeat(70));

  if (failCount > 0) {
    console.log('\n⚠  SOME TESTS FAILED — fix before pasting into Twilio.');
    process.exit(1);
  } else {
    console.log('\n✓  All handlers returned valid responses. Safe to paste.');
    process.exit(0);
  }
}

main().catch(function (e) {
  console.error('Harness crashed: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
