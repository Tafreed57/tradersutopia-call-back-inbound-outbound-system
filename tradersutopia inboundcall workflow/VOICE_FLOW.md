# Traders Utopia — Inbound Voice Flow (Agent Ringing)

This document describes how the system behaves end-to-end. Code implements this contract.

---

## 1. High-level flow

1. **Caller** dials your Twilio number → **Studio Flow** runs (e.g. Press 2 for agent).
2. Studio sets `conferenceName = TU_{CallSid}` and **HTTP POST** to `/simulring_agents`.
3. Studio **TwiML Redirect** to `/join_conference` → caller is **parked in a conference**.
4. While the caller hears “please hold” (from `waitUrl` → `/conference_wait`), **only available agents** are rung.
5. When an agent **presses 1** → that agent **joins the conference** and we **stop ringing all other agents** for this call.
6. If **no agent** joins before the wait timeout → conference is ended and caller gets the **post-conference menu** (callback / retry).

---

## 2. Who gets rung

- **Availability**: Only agents who are **not already on a call** are rung.
  - With **Twilio Sync** (`SYNC_SERVICE_SID` set): we **atomically claim** each agent (Sync Map item create). If create fails (agent already claimed), that agent is skipped. No race window.
  - Without Sync: we use REST `calls.list({ status: 'in-progress' })` as a best-effort check (small race window).
- So: **one inbound call** → rings all **available** agents. **Another inbound call** at the same time → rings only agents **not** already claimed by the first (or not in-progress).

---

## 3. When one agent **picks up** (presses 1)

- That agent is connected to the **same conference** as the caller.
- We **cancel all other ringing/queued agent legs** for **this conference only** (using Sync-stored call SIDs, or fallback by filtering our outbound calls).
- Result: **only that agent** joins this call; the others stop ringing. The caller is no longer alone in the conference.

---

## 4. When one agent **declines**

This includes both:

- **Decline at the phone** — Agent sees the call, taps “Decline” (never answers). Twilio ends that leg and calls our `agent_call_status` webhook. We only release that agent from Sync and log. We **do not** touch the conference, the caller, or other agents’ calls.
- **Decline after answering** — Agent answers, hears “Press 1 to accept,” then doesn’t press 1 or presses something else (or hangs up). We return TwiML that hangs up **that agent only** (“No response received. Goodbye.” or “Call declined. Goodbye.”).

In both cases:

- **Only that agent’s leg** ends.
- The **caller is unaffected**: they stay in the conference, still in the “please hold” loop.
- **Other agents keep ringing** until one accepts or the wait timeout hits.
- So: one agent declining **never** hangs up the caller or sends them to voicemail; it only removes that agent from this call.

---

## 5. When one agent **hangs up after joining** the conference

- The **conference** is configured so that when an **agent** leaves, the conference **does not** end (`endConferenceOnExit: false` on the agent’s `<Conference>` leg).
- So: that agent disconnects **only for themselves**. The **caller** (and any other agents still in the conference) **stay connected**. After the `<Dial>` completes (e.g. when the caller eventually hangs up), the caller gets the post-conference menu (callback / retry).

---

## 6. When the **caller** is actually “declined” or sent to the menu

The caller is **only** taken off “hold” and given the callback/retry menu when:

- The **conference wait timeout** is reached (e.g. 30 seconds) with **no agent** having joined, **or**
- The caller **hangs up**, **or**
- The conference is ended by some other explicit action (e.g. `/end_conference`).

So: **all agents declining** or **no one answering** until timeout → caller hits the timeout path and gets the menu. We do **not** end the call for the caller when a single agent declines.

---

## 7. Summary table

| Event | Effect on caller | Effect on other agents |
|-------|------------------|------------------------|
| One agent **accepts** (press 1) | Stays in conference, now with that agent | We **stop ringing** them (cancel their legs) |
| One agent **declines** (at phone or after whisper) | **No change** — stays in “please hold” | **Keep ringing** until one accepts or timeout |
| One agent **hangs up after joining** | **Stays in conference** (can use menu after) | Only that agent leaves; others stay if present |
| **Timeout** (no agent joined) | Conference ends → **callback/retry menu** | N/A |
| **Caller hangs up** | Call ends | Their legs end as usual |

---

## 8. Key functions (reference)

- **simulring_agents** — Claims available agents (Sync or REST), creates outbound legs, stores conference call SIDs in Sync.
- **agent_whisper** — Plays “Press 1 to accept”; on no input or non-1, hangs up **that agent only**.
- **agent_whisper_accept** — On “1”: cancel other conference legs, join conference (`endConferenceOnExit: false`). On other digit: hang up that agent only.
- **join_conference** — Puts caller in conference; `waitUrl` = `/conference_wait` (hold loop then timeout).
- **conference_wait** — Hold loop; on timeout, ends conference via API → caller gets post-Dial menu.
- **timeout_action** — Handles post-conference digits (callback / retry).
- **agent_call_status** — On terminal agent leg state, releases that agent from Sync.
- **conference_status_callback** — On conference end, cleans up Sync (release agents, remove conference entry).

See each file’s header comment for invocation and parameters.
