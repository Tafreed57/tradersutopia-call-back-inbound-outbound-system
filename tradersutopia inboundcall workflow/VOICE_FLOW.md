# Traders Utopia - Inbound Voice Flow (Agent Ringing)

This document describes how the system behaves end-to-end. Code implements this contract.

---

## 1. High-level flow

1. **Caller** dials your Twilio number -> **Studio Flow** runs (e.g. Press 2 for agent).
2. Studio sets `conferenceName = TU_{CallSid}` and **HTTP POST** to `/simulring_agents`.
3. Studio **TwiML Redirect** to `/join_conference` -> caller is **parked in a conference**.
4. While the caller hears "please hold" (from `waitUrl` -> `/conference_wait`), **only available agents** are rung.
5. When an agent **presses 1** -> that agent **joins the conference**, we **stop ringing all other agents**, and the caller is recorded only as a live call.
6. If **no agent** joins before the wait timeout -> conference is ended, the caller is added to the callback queue as `NEW`, and the caller gets the **post-conference menu** (callback / retry).

---

## 2. Who gets rung

- **Availability**: Only agents who are **not already on a call** are rung.
- With **Twilio Sync** (`SYNC_SERVICE_SID` set): we **atomically claim** each agent (Sync Map item create). If create fails (agent already claimed), that agent is skipped. No race window.
- Without Sync: we use REST `calls.list({ status: 'in-progress' })` as a best-effort check (small race window).
- So: **one inbound call** rings all **available** agents. **Another inbound call** at the same time rings only agents **not** already claimed by the first (or not in-progress).

---

## 3. When one agent picks up (presses 1)

- That agent is connected to the **same conference** as the caller.
- We **cancel all other ringing/queued agent legs** for **this conference only** (using Sync-stored call SIDs, or fallback by filtering our outbound calls).
- Result: **only that agent** joins this call; the others stop ringing.
- The accepted call is tracked in the `Live Calls` sheet only. It is **not** added to the callback queue.

---

## 4. When one agent declines

This includes both:

- **Decline at the phone**: Agent sees the call, taps "Decline" (never answers). Twilio ends that leg and calls our `agent_call_status` webhook. We only release that agent from Sync and log. We **do not** touch the conference, the caller, or other agents' calls.
- **Decline after answering**: Agent answers, hears "Press 1 to accept," then does not press 1, presses something else, or hangs up. We return TwiML that hangs up **that agent only**.

In both cases:

- **Only that agent's leg** ends.
- The **caller is unaffected**: they stay in the conference, still in the "please hold" loop.
- **Other agents keep ringing** until one accepts or the wait timeout hits.
- So: one agent declining **never** hangs up the caller or sends them to voicemail; it only removes that agent from this call.

---

## 5. When one agent hangs up after joining the conference

- The **conference** is configured so that when an **agent** leaves, the conference **does not** end (`endConferenceOnExit: false` on the agent's `<Conference>` leg).
- So: that agent disconnects **only for themselves**. The **caller** and any other agents still in the conference stay connected.
- The call is still not added to the callback queue just because it was successful.

---

## 6. When the caller is sent to the menu

The caller is only taken off hold and given the callback/retry menu when:

- The **conference wait timeout** is reached with **no agent** having joined, or
- The caller **hangs up**, or
- The conference is ended by some other explicit action (e.g. `/end_conference`).

Only the first case, timeout with no agent participant, creates an automatic `NEW` callback queue row. The caller can also explicitly request a callback from the post-conference menu by pressing 1.

---

## 7. Call recordings

- `/join_conference` adds `record: 'record-from-start'` to the caller conference. Twilio stores the audio as a conference recording once the caller and an agent are bridged.
- The recording does not create or update a callback queue row. Callback rows are still controlled only by missed-call timeout and explicit post-conference callback requests.
- Playback is handled by the Vercel dashboard, which lists Twilio recordings and streams audio through authenticated `/api/recordings` routes.

---

## 8. Summary table

| Event | Effect on caller | Callback queue |
|-------|------------------|----------------|
| One agent **accepts** (press 1) | Stays in conference, now with that agent | No callback row |
| One agent **declines** (at phone or after whisper) | No change; stays in "please hold" | No callback row |
| One agent **hangs up after joining** | Stays in conference | No callback row |
| **Timeout** (no agent joined) | Conference ends -> callback/retry menu | `NEW` missed-call row |
| Caller presses **1** in post-conference menu | Confirmation, then hangup | `NEW` requested-callback row |
| **Caller hangs up** | Call ends | No automatic callback row |

---

## 9. Key functions (reference)

- **simulring_agents**: Claims available agents (Sync or REST), creates outbound legs, stores conference call SIDs in Sync.
- **agent_whisper**: Plays "Press 1 to accept"; on no input or non-1, hangs up **that agent only**.
- **agent_whisper_accept**: On "1": cancel other conference legs, post `agent_on_call` so the dashboard records a live call only, then join conference (`endConferenceOnExit: false`). On other digit: retry the whisper / hang up that agent only.
- **join_conference**: Puts caller in conference; `waitUrl` = `/conference_wait` and carries caller metadata into that timeout loop.
- **conference_wait**: Hold loop; on timeout with no agent participant, writes a `NEW` missed-call callback, ends conference via API, and caller gets post-Dial menu.
- **timeout_action**: Handles post-conference digits (callback / retry). Explicit caller callback requests stay `NEW`/pending.
- **agent_call_status**: On terminal agent leg state, releases that agent from Sync.
- **conference_status_callback**: On conference end, cleans up Sync (release agents, remove conference entry).

See each file's header comment for invocation and parameters.
