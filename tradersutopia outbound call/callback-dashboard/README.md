# Callback Dashboard - TradersUtopia

Affiliate callback queue, Twilio inbound routing, bridge dialer, live-call view, and recording playback. Operational data is stored in PostgreSQL through a private Supabase Edge Function. Audio remains stored by Twilio and is streamed through the authenticated dashboard.

## Architecture

- Next.js on Vercel serves the dashboard and authenticated API routes.
- Supabase Postgres stores callbacks, routing, call logs, live-call state, recording favorites, and push subscriptions.
- The `callback-data` Edge Function is the only database gateway. Its shared secret is server-side only.
- Twilio Studio and the `tu-voice-routing` Function Service handle inbound calls, conferences, recordings, and missed-call events.
- A normalized phone-number unique constraint guarantees one callback row per caller. A later missed call refreshes that row and moves it to the top.

## Environment

Copy `.env.example` to `.env.local` for local development. Production variables belong in Vercel.

Required application variables:

```text
TWILIO_SID=AC...
TWILIO_AUTH=...
TWILIO_NUMBER=+18555077602
TWILIO_NUMBERS=+18555077602,+18444844459
TWILIO_NUMBER_LABELS=Cancellation,Sales
TWILIO_STUDIO_FLOW_URL=https://webhooks.twilio.com/v1/Accounts/AC.../Flows/FW...
AFFILIATE_ACCESS_CODE=...
CALL_ROUTING_SECRET=...
CALL_ROUTING_DEFAULT_AGENTS=+15551234567
CALLBACK_DB_API_URL=https://PROJECT_REF.supabase.co/functions/v1/callback-data
CALLBACK_DB_API_SECRET=...
```

`CALLBACK_DB_API_SECRET` must never use a `NEXT_PUBLIC_` prefix. The browser only talks to authenticated Next.js routes.

## Development

```bash
npm install
npm run dev
```

Twilio cannot call localhost. Set `PUBLIC_BASE_URL` to an HTTPS tunnel only when testing call webhooks locally. Leave it unset on Vercel.

## Database

Schema changes are stored under `supabase/migrations`. The production tables use the `callback_` prefix and have RLS enabled with no `anon` or `authenticated` policies. The Edge Function uses its server-side service credential.

The one-time legacy import is idempotent:

```bash
npm run migrate:sheets
```

Google credentials are only needed while running that migration. The production dashboard and Twilio routing no longer read or write Google Sheets.

## Twilio

The live `tu-voice-routing` Service should use:

```text
CALL_ROUTING_URL=https://tradersutopia-callback-dashboard.vercel.app/api/call-routing/runtime
CALLBACK_SCRIPT_URL=https://tradersutopia-callback-dashboard.vercel.app/api/twilio-data
DASHBOARD_API_URL=https://tradersutopia-callback-dashboard.vercel.app
```

Set the same `CALL_ROUTING_SECRET` in Twilio and Vercel. These Function paths include it as the `x-call-routing-secret` header when writing dashboard state:

- `/conference_wait`
- `/timeout_action`
- `/agent_whisper_accept`
- `/agent_call_status`

Run `npm run twilio:cutover` to update those versions and deploy a complete Twilio build. Missed callbacks are accepted only when the conference timeout reports `missed_no_agent`; successful connected calls do not enter the callback queue.

## Recordings

- Twilio stores the recording audio.
- Inbound conferences begin recording only when an agent joins.
- Outbound calls use answering-machine detection and exclude voicemail-only legs.
- The dashboard fetches recent recordings from Twilio and stores only favorite metadata in Postgres.
- Favorites remain visible after a recording leaves the recent-call window.

## Production Checks

```bash
npm run lint
npm run build
npx vercel --prod --yes
```

Verify `/api/leads`, `/api/live-calls`, `/api/call-routing`, and `/api/recordings` through an authenticated dashboard session. The Twilio runtime routing endpoint uses `x-call-routing-secret` rather than the dashboard access code.

## Troubleshooting

- **Invalid access code:** confirm `AFFILIATE_ACCESS_CODE` in Vercel.
- **PostgreSQL database gateway is not configured:** add both `CALLBACK_DB_API_URL` and `CALLBACK_DB_API_SECRET` and redeploy.
- **Unauthorized Twilio data webhook:** confirm `CALL_ROUTING_SECRET` matches in Vercel and Twilio, and that the four Function paths send the header.
- **No inbound agents:** open Routing and assign at least one enabled agent to the called line.
- **Recording missing:** confirm the call connected to a human and that Twilio produced a completed recording.
