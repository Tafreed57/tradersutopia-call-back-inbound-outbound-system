import nextEnv from "@next/env";
import { google } from "googleapis";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const gatewayUrl = process.env.CALLBACK_DB_API_URL;
const gatewaySecret = process.env.CALLBACK_DB_API_SECRET;
if (!gatewayUrl || !gatewaySecret) {
  throw new Error("Set CALLBACK_DB_API_URL and CALLBACK_DB_API_SECRET before migrating");
}

const spreadsheetId = process.env.GOOGLE_SHEET_ID;
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
if (!spreadsheetId || !credentials.client_email) {
  throw new Error("Google Sheets migration credentials are not configured");
}

const tabs = {
  leads: process.env.GOOGLE_SHEET_CALLBACKS_TAB || "Callbacks",
  logs: process.env.GOOGLE_SHEET_LOGS_TAB || "CallLogs",
  routing: process.env.GOOGLE_SHEET_CALL_ROUTING_TAB || "Call Routing",
  favorites: process.env.GOOGLE_SHEET_RECORDING_FAVORITES_TAB || "Recording Favorites",
  liveCalls: process.env.GOOGLE_SHEET_LIVE_CALLS_TAB || "Live Calls",
  pushSubscriptions: process.env.GOOGLE_SHEET_PUSH_SUBS_TAB || "Push Subscriptions",
  pushNotified: process.env.GOOGLE_SHEET_PUSH_NOTIFIED_TAB || "Push Notified",
};

const ranges = [
  ["leads", "A:I"],
  ["logs", "A:G"],
  ["routing", "A:H"],
  ["favorites", "A:U"],
  ["liveCalls", "A:G"],
  ["pushSubscriptions", "A:D"],
  ["pushNotified", "A:C"],
];

function sheetRange(tab, range) {
  return `'${tab.replaceAll("'", "''")}'!${range}`;
}

function string(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function phone(value) {
  const digits = string(value).replace(/\D/g, "");
  if (!digits) return "";
  return `+${digits.length === 10 ? `1${digits}` : digits}`;
}

function phoneKey(value) {
  return phone(value).replace(/\D/g, "");
}

function timestamp(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(Math.round((value - 25569) * 86_400_000)).toISOString();
  }
  if (!string(value)) return fallback;
  const parsed = new Date(string(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function boolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = string(value).toLowerCase();
  if (!normalized) return fallback;
  return normalized === "true" || normalized === "yes" || normalized === "1";
}

async function readSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  let delay = 30_000;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: ranges.map(([name, range]) => sheetRange(tabs[name], range)),
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      return Object.fromEntries(
        ranges.map(([name], index) => [name, response.data.valueRanges?.[index]?.values || []])
      );
    } catch (error) {
      if (attempt === 5 || !String(error?.message || error).includes("Quota exceeded")) throw error;
      console.log(`Google quota is still cooling down; retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 120_000);
    }
  }
}

async function gateway(table, rows) {
  const chunkSize = 200;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gatewaySecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "import.batch", payload: { table, rows: chunk } }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(`${table} import failed: ${result.error || response.status}`);
    }
  }
  console.log(`${table}: ${rows.length} row(s)`);
}

const data = await readSheets();
const now = new Date().toISOString();

const leadByPhone = new Map();
for (const [index, row] of data.leads.slice(1).entries()) {
  const normalizedPhone = phone(row[1]);
  const key = phoneKey(normalizedPhone);
  if (!key) continue;
  const createdAt = timestamp(row[0], now);
  const rawStatus = string(row[3]).toLowerCase();
  const lead = {
    id: string(row[6]) || `legacy-${index + 2}-${key}`,
    phone: normalizedPhone,
    phone_key: key,
    created_at: createdAt,
    name: string(row[2]) ? `Lead (${string(row[2])})` : "Lead",
    reason: string(row[2]),
    status: rawStatus === "new" || rawStatus === "pending" || !rawStatus ? "pending" : "called",
    called_at: null,
    called_by: string(row[4]),
    notes: string(row[5]),
    last_updated_at: createdAt,
    called_number: phone(row[7]),
    source_call_sid: string(row[6]),
    digits: string(row[8]),
  };
  const existing = leadByPhone.get(key);
  if (!existing || Date.parse(lead.created_at) >= Date.parse(existing.created_at)) {
    leadByPhone.set(key, lead);
  }
}

const logs = data.logs.slice(1).flatMap((row) => {
  const logId = string(row[0]);
  if (!logId) return [];
  return [{
    log_id: logId,
    created_at: timestamp(row[1], now),
    lead_id: string(row[2]),
    action: string(row[3]) || "LEGACY",
    affiliate_phone: phone(row[4]),
    details: string(row[5]),
    twilio_call_sid: string(row[6]),
  }];
});

const routingLines = [];
const routingAgents = [];
const routingAssignments = [];
for (const row of data.routing.slice(1)) {
  const type = string(row[0]).toLowerCase();
  const normalizedPhone = phone(row[1]);
  if (!normalizedPhone) continue;
  if (type === "line") {
    routingLines.push({
      phone: normalizedPhone,
      label: string(row[2]) || normalizedPhone,
      enabled: boolean(row[3], true),
      is_default: boolean(row[4]),
      twilio_sid: string(row[5]),
      updated_at: timestamp(row[6], now),
    });
  } else if (type === "agent") {
    routingAgents.push({
      phone: normalizedPhone,
      label: string(row[2]) || "Agent",
      enabled: boolean(row[3], true),
      updated_at: timestamp(row[6], now),
    });
    for (const linePhone of string(row[7]).split(",").map(phone).filter(Boolean)) {
      routingAssignments.push({ agent_phone: normalizedPhone, line_phone: linePhone });
    }
  }
}

const favorites = data.favorites.slice(1).flatMap((row) => {
  const sid = string(row[0]);
  if (!/^RE[0-9a-fA-F]{32}$/.test(sid)) return [];
  return [{
    recording_sid: sid,
    favorited_at: timestamp(row[1], now),
    recording: {
      sid,
      callSid: string(row[2]),
      conferenceSid: string(row[3]),
      conferenceName: string(row[4]),
      status: string(row[5]),
      dateCreated: timestamp(row[6], string(row[6])),
      duration: string(row[7]),
      channels: Number(row[8] || 0),
      source: string(row[9]),
      from: string(row[10]),
      to: string(row[11]),
      direction: string(row[12]),
      callStatus: string(row[13]),
      startTime: timestamp(row[14], string(row[14])),
      endTime: timestamp(row[15], string(row[15])),
      customerPhone: string(row[16]),
      agentPhone: string(row[17]),
      answeredBy: string(row[18]),
      connectedDuration: Number(row[19] || 0),
      verification: string(row[20]) || "connected-duration",
    },
  }];
});

const liveCalls = data.liveCalls.slice(1).flatMap((row) => {
  const agentNumber = phone(row[0]);
  const conferenceName = string(row[1]);
  if (!agentNumber || !conferenceName) return [];
  return [{
    agent_number: agentNumber,
    conference_name: conferenceName,
    caller_number: phone(row[2]),
    start_time: timestamp(row[3]),
    status: string(row[4]).toUpperCase() === "LIVE" ? "LIVE" : "ENDED",
    call_duration: string(row[5]),
    end_time: timestamp(row[6]),
    updated_at: timestamp(row[6], timestamp(row[3], now)),
  }];
});

const pushSubscriptions = data.pushSubscriptions.slice(1).flatMap((row) => {
  const endpoint = string(row[0]);
  if (!endpoint) return [];
  return [{
    endpoint,
    p256dh: string(row[1]),
    auth: string(row[2]),
    created_at: timestamp(row[3], now),
  }];
});

const pushNotifiedByKey = new Map();
for (const row of data.pushNotified.slice(1)) {
  const agentNumber = phone(row[0]);
  const conferenceName = string(row[1]);
  if (!agentNumber || !conferenceName) continue;
  const notified = {
    agent_number: agentNumber,
    conference_name: conferenceName,
    notified_at: timestamp(row[2], now),
  };
  const key = `${agentNumber}::${conferenceName}`;
  const existing = pushNotifiedByKey.get(key);
  if (!existing || Date.parse(notified.notified_at) >= Date.parse(existing.notified_at)) {
    pushNotifiedByKey.set(key, notified);
  }
}
const pushNotified = [...pushNotifiedByKey.values()];

await gateway("routingLines", routingLines);
await gateway("routingAgents", routingAgents);
await gateway("routingAssignments", routingAssignments);
await gateway("leads", [...leadByPhone.values()]);
await gateway("logs", logs);
await gateway("favorites", favorites);
await gateway("liveCalls", liveCalls);
await gateway("pushSubscriptions", pushSubscriptions);
await gateway("pushNotified", pushNotified);

console.log("Google Sheets migration completed successfully.");
