# Traders Utopia — Inbound & Outbound Call Lead System

> **Full-stack telephony platform** for handling inbound customer calls with multi-agent simulring and outbound callback/lead management with Twilio, Next.js, and Google Sheets.

[![Twilio](https://img.shields.io/badge/Twilio-Voice%20%26%20SMS-F22F46?logo=twilio)](https://www.twilio.com)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js)](https://nextjs.org)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org)

---

## Overview

This repository contains a **production-style call center solution** with two integrated subsystems:

| System | Purpose |
|--------|--------|
| **Inbound** | When a customer calls your Twilio number, the caller is parked in a conference while **all available agents** are rung simultaneously. The first agent to press **1** joins the call; others stop ringing. Includes whisper (“Press 1 to accept”), timeout handling, and callback/retry menus. |
| **Outbound** | Web dashboard for affiliates to view a **callback/lead queue** (backed by Google Sheets), click-to-call leads, mark status, and receive **push notifications** when inbound calls are taken. Supports manual dial and live call visibility. |

Both systems use **Twilio Voice** for PSTN connectivity and are designed to be deployed (Twilio Functions + Studio for inbound; Next.js on Vercel for outbound).

---

## Features

### Inbound call workflow

- **Simulring** — One inbound call rings all available agents at once (no round-robin delay).
- **Atomic agent availability** — Twilio Sync (or REST fallback) ensures only agents not already on a call are rung; no double-assignment.
- **Whisper gate** — Agents hear “Press 1 to accept”; voicemail/IVR cannot press 1, so only humans join.
- **Single-agent join** — When one agent accepts, all other legs for that conference are cancelled; caller stays in hold until then.
- **Decline-safe** — If an agent declines (at phone or after whisper), only that agent’s leg ends; caller and other agents are unaffected.
- **Conference timeout** — Configurable wait (e.g. 30s); if no agent joins, caller gets a post-conference menu (callback / try again).
- **Post-call menu** — Handled in Twilio Functions (callback request, retry) with optional SMS notify to other agents when one takes the call.
- **Structured logging** — JSON logs with request IDs and correlation for debugging in Twilio Live Logs.

### Outbound / callback dashboard

- **Lead queue** — Leads stored in **Google Sheets** (Callback Queue tab); affiliates see only their data via access-code auth.
- **Click-to-call** — “Call” initiates a **bridge**: Twilio calls the affiliate first, then (on answer) dials the lead with Twilio caller ID; affiliate hears “Connecting you to your callback.”
- **Status & notes** — Mark lead as *called* / *pending*; add notes; all persisted to Sheets with retry logic.
- **Manual dial** — Dial any E.164 number from the dashboard (with emergency/special-number blocklist).
- **Live calls panel** — Real-time view of active conferences (inbound) from a “Live Calls” sheet, with optional push when an agent takes a call.
- **Push notifications** — Web Push (VAPID) for “agent took a call” and callback alerts; subscription state stored in Sheets.
- **Responsive UI** — Dark theme, desktop table + mobile cards, optimistic updates, and clear error handling.

---

## Architecture

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    INBOUND FLOW                         │
                    └─────────────────────────────────────────────────────────┘
  Customer calls Twilio #  →  Studio (e.g. “Press 2 for agent”)
       →  HTTP POST /simulring_agents (conferenceName)
       →  TwiML Redirect to /join_conference  →  Caller parked in conference
       →  Only available agents rung (Sync or REST)
       →  Agent answers  →  /agent_whisper (“Press 1 to accept”)
       →  Agent presses 1  →  /agent_whisper_accept  →  Join conference, cancel others
       →  Timeout (no agent)  →  /conference_wait ends conference  →  Post-call menu

                    ┌─────────────────────────────────────────────────────────┐
                    │                   OUTBOUND FLOW                         │
                    └─────────────────────────────────────────────────────────┘
  Affiliate opens dashboard  →  Access code + phone  →  GET /api/leads (from Sheets)
       →  Click “Call”  →  POST /api/start-call  →  Twilio calls affiliate
       →  Affiliate answers  →  Twilio GET/POST /api/bridge  →  TwiML: whisper + dial lead
       →  Lead rings; call logged; status updated in Sheets (Mark Called, notes)
```

- **Inbound**: Twilio Studio + **Twilio Functions** (Node.js) for `/simulring_agents`, `/join_conference`, `/agent_whisper`, `/agent_whisper_accept`, `/conference_wait`, `/timeout_action`, `/agent_call_status`, `/conference_status_callback`, etc.
- **Outbound**: **Next.js** (App Router) on Vercel; **Google Sheets API** (Service Account) as backend DB; **Twilio** for bridge calls and optional live-call visibility; **Web Push** for notifications.

---

## Tech stack

| Layer | Inbound | Outbound |
|-------|---------|----------|
| **Runtime** | Node.js (Twilio Functions) | Node.js (Next.js 16) |
| **Language** | JavaScript | TypeScript |
| **Voice / SMS** | Twilio (Voice, Conferences, Sync, optional SMS) | Twilio (Calls API, TwiML) |
| **Data** | Twilio Sync (agent claim + conference call SIDs) | Google Sheets API (leads, logs, live calls, push subs) |
| **Frontend** | — | React 19, Tailwind CSS 4 |
| **Deploy** | Twilio Console (Functions + Studio) | Vercel |
| **Push** | — | Web Push (web-push, VAPID), Service Worker |

---

## Project structure

```
.
├── README.md                    ← You are here
├── LICENSE
├── .gitignore
│
├── tradersutopia inboundcall workflow/   # Inbound — Twilio Functions
│   ├── package.json
│   ├── VOICE_FLOW.md                     # Inbound flow specification
│   ├── simulring_agents.js               # POST: ring available agents
│   ├── join_conference.js                # TwiML: park caller in conference
│   ├── conference_wait.js                # Hold loop + timeout → end conference
│   ├── agent_whisper.js                  # “Press 1 to accept”
│   ├── agent_whisper_accept.js            # Join conference, cancel others, optional SMS
│   ├── agent_call_status.js              # Release agent from Sync on leg end
│   ├── conference_status_callback.js     # Cleanup Sync on conference end
│   ├── timeout_action.js                 # Post-conference menu (callback/retry)
│   ├── end_conference.js                 # Utility: end conference via API
│   ├── check_conference.js               # Utility: conference state
│   └── test_harness.js                   # Local test for simulring_agents
│
└── tradersutopia outbound call/           # Outbound — Next.js dashboard
    ├── package.json
    ├── README.md                         # Setup runbook (Sheets, Twilio, Vercel)
    ├── SETUP-GOOGLE-CLOUD.md
    ├── app/
    │   ├── page.tsx                      # Redirect to /dashboard
    │   ├── dashboard/page.tsx            # Main dashboard (leads, call, manual dial, live calls, push)
    │   └── api/
    │       ├── bridge/route.ts           # Twilio webhook → TwiML (whisper + dial lead)
    │       ├── start-call/route.ts       # Start bridge call, log to Sheets
    │       ├── dial-number/route.ts      # Manual dial (any number)
    │       ├── leads/route.ts            # GET leads (Sheets)
    │       ├── leads/[id]/route.ts       # PATCH lead (status, notes)
    │       ├── live-calls/route.ts        # GET live calls (Sheets)
    │       └── push/
    │           ├── subscribe/route.ts
    │           ├── unsubscribe/route.ts
    │           └── send/route.ts
    ├── lib/
    │   ├── twilio.ts                     # startBridgeCall, buildBridgeTwiml, isE164
    │   ├── sheets.ts                     # Google Sheets CRUD (leads, logs, live, push)
    │   ├── base-url.ts                   # PUBLIC_BASE_URL / VERCEL_URL
    │   ├── retry.ts                      # withRetry for Sheets API
    │   └── emergency.ts                  # Emergency/special number blocklist
    └── public/
        └── sw.js                         # Service Worker for push
```

---

## Skills demonstrated

This project showcases:

- **Telephony / CPaaS** — Twilio Voice (TwiML, Conferences, Sync), multi-leg flows, webhooks, status callbacks.
- **Backend design** — Serverless (Twilio Functions, Next.js API routes), idempotent agent claiming, graceful fallbacks (Sync → REST).
- **Full-stack web** — Next.js App Router, React (hooks, optimistic UI), TypeScript, RESTful API design.
- **Integrations** — Google Sheets as database (Service Account auth, batch reads/writes, retries), Web Push (VAPID, Service Worker).
- **Security & validation** — Access-code auth, E.164 validation, emergency-number blocklist, server-side-only secrets.
- **Operational concerns** — Structured logging, correlation IDs, timeout handling, and clear runbooks (README, SETUP-GOOGLE-CLOUD).

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Twilio](https://www.twilio.com) account (voice number, Functions, optional Sync)
- Google Cloud project with Sheets API and a Service Account (for outbound)
- (Optional) [ngrok](https://ngrok.com) for local Twilio webhook testing

### Inbound (Twilio Functions)

1. Open the **tradersutopia inboundcall workflow** folder.
2. Copy the Functions into your Twilio project (e.g. via Console or Twilio CLI).
3. Set environment variables: `FROM_NUMBER`, `AGENT_LIST`, optionally `SYNC_SERVICE_SID`, `BASE_URL`, `MAX_WAIT_MS`, `SMS_FROM_NUMBER`, `CALLBACK_SCRIPT_URL`.
4. In Studio: configure the flow to set `conferenceName` (e.g. `TU_{CallSid}`), POST to `/simulring_agents`, then TwiML Redirect to `/join_conference`.
5. See **VOICE_FLOW.md** in that folder for the full behavioral contract.

### Outbound (Next.js dashboard)

1. Open the **tradersutopia outbound call** folder.
2. Follow the **README.md** and **SETUP-GOOGLE-CLOUD.md** there: Google Sheet, Service Account JSON, env vars (`TWILIO_*`, `GOOGLE_*`, `AFFILIATE_ACCESS_CODE`, etc.).
3. Run `npm install` and `npm run dev`; for local Twilio webhooks set `PUBLIC_BASE_URL` to your ngrok URL.
4. Deploy to Vercel and set the same env vars in the project settings.

---

## Repository

- **GitHub**: [Tafreed57/tradersutopia-call-back-inbound-outbound-system](https://github.com/Tafreed57/tradersutopia-call-back-inbound-outbound-system)
- **License**: MIT (see [LICENSE](LICENSE)).

---

*Built for Traders Utopia — inbound and outbound call and lead management.*
