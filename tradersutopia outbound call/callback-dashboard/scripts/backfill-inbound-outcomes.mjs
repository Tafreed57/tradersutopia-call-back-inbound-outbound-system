import nextEnv from "@next/env";
import twilio from "twilio";
import { readFile } from "node:fs/promises";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const apply = process.argv.includes("--apply");
const daysArg = process.argv.find(value => value.startsWith("--days="));
const days = Math.min(30, Math.max(1, Number(daysArg?.split("=")[1] || 7)));
if (!Number.isFinite(days)) throw new Error("--days must be a number");
const verifiedFile = process.argv.find(value => value.startsWith("--verified-missed="))?.slice("--verified-missed=".length);
const verifiedSids = verifiedFile ? JSON.parse(await readFile(verifiedFile, "utf8")) : [];
if (!Array.isArray(verifiedSids) || verifiedSids.some(sid => typeof sid !== "string" || !/^CA[0-9a-fA-F]{32}$/.test(sid))) {
  throw new Error("--verified-missed must name a JSON array of audited missed inbound Call SIDs");
}
const verifiedMissed = new Set(verifiedSids);
const account = process.env.TWILIO_SID;
const token = process.env.TWILIO_AUTH;
const databaseUrl = process.env.CALLBACK_DB_API_URL;
const databaseSecret = process.env.CALLBACK_DB_API_SECRET;
if (!account || !token || !databaseUrl || !databaseSecret) {
  throw new Error("Twilio and PostgreSQL gateway credentials are required");
}

async function database(action, payload = {}) {
  const response = await fetch(databaseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${databaseSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, payload }),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Database request failed (${response.status})`);
  }
  return result.data;
}

const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const [calls, liveCalls, routing] = await Promise.all([
  twilio(account, token).calls.list({ startTimeAfter: cutoff, limit: 5000 }),
  database("live_calls.list"),
  database("routing.get"),
]);
if (calls.length === 5000) throw new Error("Call list reached its limit; rerun with a smaller --days window");
const lines = new Set((routing.lines || []).map(line => line.phone));
const terminalStatuses = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
const settledBefore = Date.now() - 120_000;
const inbound = calls.filter(call =>
  call.direction === "inbound" &&
  lines.has(call.to) &&
  terminalStatuses.has(call.status) &&
  call.endTime instanceof Date &&
  call.endTime.getTime() < settledBefore &&
  /^CA[0-9a-fA-F]{32}$/.test(call.sid) &&
  /^\+[1-9]\d{6,14}$/.test(call.from)
);
const connected = new Map();
for (const live of liveCalls || []) {
  const name = String(live.conferenceName || "");
  const match = /^TU_(CA[0-9a-fA-F]{32})(?:_|$)/.exec(name);
  if (match && live.startTime) connected.set(match[1], live.startTime);
}

// Missing legacy telemetry is not evidence of a missed call. Only an explicitly
// audited list may create missed callbacks; incomplete history stays untouched.
const eligible = inbound.filter(call => connected.has(call.sid) || verifiedMissed.has(call.sid));
console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  days,
  inboundCalls: inbound.length,
  connectedCalls: inbound.filter(call => connected.has(call.sid)).length,
  verifiedMissed: eligible.filter(call => !connected.has(call.sid)).length,
  unverifiedSkipped: inbound.length - eligible.length,
}));
if (!apply) {
  console.log("Only connected calls and --verified-missed=<audited-sids.json> entries are eligible. Use --apply after reviewing.");
  process.exit(0);
}

let saved = 0;
for (const call of eligible) {
  await database("inbound.record", {
    callSid: call.sid,
    phone: call.from,
    calledNumber: call.to,
    startedAt: (call.startTime || call.dateCreated).toISOString(),
    endedAt: call.endTime.toISOString(),
    answeredAt: connected.get(call.sid) || null,
  });
  saved++;
}
console.log(JSON.stringify({ saved }));
