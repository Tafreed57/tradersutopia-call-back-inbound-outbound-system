# Production Reliability Release

Verified September 10, 2026 (UTC).

## Live Services

- Dashboard: https://tradersutopia-callback-dashboard.vercel.app
- Vercel application directory: `tradersutopia outbound call/callback-dashboard`
- Vercel deployment: `dpl_8TwGRd3XCR5tRK6bDT2Z1kApSv9u`
- Dashboard runtime source commit: `cddb770`. Subsequent changes are Twilio functions, release tooling, tests, and this report; no additional dashboard runtime changes.
- Twilio Serverless service: `ZS460b4815c0556adeef4f71a4b0ba47a7`
- Twilio environment: `ZE742b39f7f4635ac14b83afd8ff01a418`
- Final Twilio build: `ZB089474096b5a6dadf77d3b04b576deb8`
- Final Twilio deployment: `ZD4092e52b5db3b41509149a454db88480`
- Studio flow: `FW0e50c6f78cbeb6ac755a8db47dfe7015`, published revision 800.
- Both Cancellation and Sales numbers retain that voice flow and now send terminal call status to `/api/inbound-status`.
- PostgreSQL gateway `callback-data` version 3 and both inbound-outcome migrations are deployed in Supabase project `teumahtrfbrojugjrdhy`.

## Fixes

### Recording Playback

The observed Twilio MP3 response streamed without a finite Content-Length and did not honor byte ranges. Forwarding that response directly left the browser unable to seek reliably.

`lib/recording-media.ts` now finishes the upstream download, exposes the exact length, and serves finite byte ranges, including suffix requests and late seeks. The media route supports HEAD, bounded range responses, authenticated access, and a streamed full response for larger files. The in-process cache is bounded and concurrent downloads of the same recording are coalesced.

Audio remains stored in Twilio. The dashboard authenticates playback and proxies the bytes; this release does not create an independent archival copy. Existing favorite markers are preserved.

### Inbound Routing

Studio's wrapped form body was not reliably providing the called line and caller SID to agent routing. The function now parses the complete form, recovers the original call SID from the conference name, and reads the actual calling/called numbers from Twilio.

The live `SYNC_SERVICE_SID` incorrectly named a Serverless service. It now points to the verified Sync service, enabling atomic agent claims. Ended callers cannot start agent calls; failed call creation releases claims; the first accepting agent wins; and accepted calls retain their claim for four hours instead of expiring after five minutes.

### Missed Callbacks

The old Studio Google Sheets callback widget is removed. Number-level terminal callbacks persist authoritative inbound call facts to PostgreSQL, including callers who leave the opening menu without requesting a callback.

Actual conference agent-join events mark calls answered. Terminal outcomes are finalized after a 90-second grace period by a database job running every minute. A missed callback can therefore take roughly two to three minutes to appear after hangup. Answered calls are excluded, including a successful retry within the original inbound call.

Repeated missed calls update the existing normalized-phone row. Late answer events undo an automatic missed classification without overwriting subsequent manual work. Callback retries are idempotent. Number status callbacks continue forwarding the full event to Studio so executions close normally.

Conference callbacks retry dashboard delivery and return errors on exhausted delivery attempts. Their TwiML URLs also request Twilio retries for connection failures, read timeouts, and server errors. This follows [Twilio's connection override documentation](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides).

## Changed Twilio Functions

These five functions have already been deployed through the API with protected visibility; manual Console edits are not needed:

- `tradersutopia inboundcall workflow/simulring_agents.js`
- `tradersutopia inboundcall workflow/agent_whisper_accept.js`
- `tradersutopia inboundcall workflow/agent_call_status.js`
- `tradersutopia inboundcall workflow/conference_status_callback.js`
- `tradersutopia inboundcall workflow/join_conference.js`

The deployment preserves other live functions, assets, dependencies, and runtime. Its tooling requires the expected current build SID and checks for concurrent Twilio/Studio changes before overwriting them.

## Verification

- Production browser playback: a 12,724,872-byte, approximately 53-minute recording showed a finite duration of 3181.218 seconds. Seeking to the final eight seconds and playing to the end succeeded with no media or page errors.
- Desktop (1440x1000) and mobile (390x844) screenshots inspected; no page-width overflow.
- Authenticated prefix and final-byte requests returned HTTP 206 with correct lengths and Content-Range values. The browser also received the late seek range correctly.
- Unsigned inbound webhook rejected with 403; replay of a complete, genuine terminal event returned 200 and forwarded successfully to Studio.
- A deliberately incomplete initial test event produced a Studio 400 forwarding error. That was a test-fixture error, not a genuine failed customer call; the complete replay passed.
- Final Twilio read-back verified both numbers, revision 800, the Sync service, protected function visibility, and callback retry configuration. Signed function probes passed. A completed-caller probe created zero agent calls.
- Final checks found zero errors in the new Twilio build's available logs, zero duplicate callback phone rows, zero overdue inbound outcomes, and zero finalizer failures in the last hour.
- 12 recording/recovery unit tests and 10 inbound workflow regression tests passed.
- SQL rollback tests covered missed calls, duplicate/replayed events, late answers, answered retries, and preservation of manual callback work. No test rows remain.
- Local production build and Vercel production build succeeded. Lint passed with two pre-existing unused-variable warnings in `lib/emergency.ts` and `public/sw.js`.

Historical recovery processed 36 recent inbound calls: 10 answered and 26 missed. Call-event timelines were cross-checked: long missed calls stayed in hold/retry menus, while short abandoned calls ended in the opening flow. The recovery utility is now stricter: it skips active/unsettled calls and unrelated lines, defaults to dry run, and requires an explicitly reviewed SID list before importing missed calls with absent legacy answer telemetry.

## Remaining Boundaries

- No new calls were placed to agents or customers during testing. A controlled real inbound answer, inbound hangup, and outbound callback remain the final carrier/device acceptance checks; automated tests cannot guarantee an agent's handset or carrier will accept a call.
- Very long recordings can initially take time to prepare. The observed cold fetch of the 53-minute file took about 26 seconds. Audio is bounded to 128 MiB per file, with a 90-second upstream timeout and a 64 MiB in-process cache; larger or unusually slow recordings return an error instead of silently truncating.
- Callback tables have RLS enabled and deny browser access; their server-side gateway uses the service role. The advisory about having no browser RLS policies is expected for this architecture.
