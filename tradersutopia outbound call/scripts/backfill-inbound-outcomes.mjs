import nextEnv from "@next/env";
import twilio from "twilio";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const apply = process.argv.includes("--apply");
const daysArg = process.argv.find(value => value.startsWith("--days="));
const days = Math.min(30, Math.max(1, Number(daysArg?.split("=")[1] || 7)));
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
const [calls, liveCalls] = await Promise.all([
  twilio(account, token).calls.list({ startTimeAfter: cutoff, limit: 5000 }),
  database("live_calls.list"),
]);
const inbound = calls.filter(call =>
  call.direction === "inbound" &&
  /^CA[0-9a-fA-F]{32}$/.test(call.sid) &&
  /^\+[1-9]\d{6,14}$/.test(call.from)
);
const connected = new Map();
for (const live of liveCalls || []) {
  const name = String(live.conferenceName || "");
  const match = /^TU_(CA[0-9a-fA-F]{32})(?:_|$)/.exec(name);
  if (match && live.startTime) connected.set(match[1], live.startTime);
}

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  days,
  inboundCalls: inbound.length,
  connectedCalls: inbound.filter(call => connected.has(call.sid)).length,
  missedCandidates: inbound.filter(call => !connected.has(call.sid)).length,
}));
if (!apply) {
  console.log("Run again with --apply to persist these idempotent observations.");
  process.exit(0);
}

let saved = 0;
for (const call of inbound) {
  await database("inbound.record", {
    callSid: call.sid,
    phone: call.from,
    calledNumber: call.to,
    startedAt: (call.startTime || call.dateCreated).toISOString(),
    endedAt: (call.endTime || call.dateUpdated).toISOString(),
    answeredAt: connected.get(call.sid) || null,
  });
  saved++;
}
console.log(JSON.stringify({ saved }));

