import { google, sheets_v4 } from "googleapis";
import { revalidateTag, unstable_cache } from "next/cache";
import twilio from "twilio";

type SheetCell = string | number | boolean | null | undefined;

const ROUTING_HEADERS = [
  "type",
  "phone",
  "label",
  "enabled",
  "isDefault",
  "twilioSid",
  "updatedAt",
];
const ROUTING_CACHE_TAG = "call-routing-config";

export interface RoutingAgent {
  phone: string;
  label: string;
  enabled: boolean;
  updatedAt: string;
}

export interface RoutingLine {
  phone: string;
  label: string;
  enabled: boolean;
  isDefault: boolean;
  twilioSid: string;
  updatedAt: string;
}

export interface CallRoutingConfig {
  agents: RoutingAgent[];
  lines: RoutingLine[];
}

function routingTab(): string {
  return process.env.GOOGLE_SHEET_CALL_ROUTING_TAB || "Call Routing";
}

function sheetRange(range: string): string {
  return `'${routingTab().replace(/'/g, "''")}'!${range}`;
}

function getSheets(): sheets_v4.Sheets {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function spreadsheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error("Missing GOOGLE_SHEET_ID env var");
  return id;
}

function cell(value: SheetCell): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function booleanCell(value: SheetCell, defaultValue = false): boolean {
  if (typeof value === "boolean") return value;
  const normalized = cell(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === "true" || normalized === "yes" || normalized === "1";
}

function normalizePhone(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export function isRoutingPhone(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

function envList(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map(normalizePhone)
    .filter(isRoutingPhone);
}

function seedRows(): Array<Array<string | boolean>> {
  const now = new Date().toISOString();
  const lines = envList("TWILIO_NUMBERS");
  const defaultNumber = normalizePhone(process.env.TWILIO_NUMBER || "");
  if (isRoutingPhone(defaultNumber) && !lines.includes(defaultNumber)) {
    lines.unshift(defaultNumber);
  }

  const labels = (process.env.TWILIO_NUMBER_LABELS || "Cancellation,Sales")
    .split(",")
    .map((label) => label.trim());
  const agents = envList("CALL_ROUTING_DEFAULT_AGENTS").length
    ? envList("CALL_ROUTING_DEFAULT_AGENTS")
    : envList("AGENT_LIST");

  return [
    ...lines.map((phone, index) => [
      "line",
      phone,
      labels[index] || `Line ${index + 1}`,
      true,
      index === 0,
      "",
      now,
    ]),
    ...agents.map((phone, index) => [
      "agent",
      phone,
      `Agent ${index + 1}`,
      true,
      false,
      "",
      now,
    ]),
  ];
}

let routingReady: Promise<void> | null = null;

async function ensureRoutingSheet(): Promise<void> {
  if (routingReady) return routingReady;

  routingReady = (async () => {
    const sheets = getSheets();
    const id = spreadsheetId();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
    const exists = (meta.data.sheets || []).some(
      (sheet) => sheet.properties?.title === routingTab()
    );

    if (!exists) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: {
            requests: [{ addSheet: { properties: { title: routingTab() } } }],
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("already exists")) throw error;
      }
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: sheetRange("A1:G1"),
      valueInputOption: "RAW",
      requestBody: { values: [ROUTING_HEADERS] },
    });

    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: id,
      range: sheetRange("A2:G"),
    });
    if ((existing.data.values || []).length === 0) {
      const rows = seedRows();
      if (rows.length > 0) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: id,
          range: sheetRange("A:G"),
          valueInputOption: "RAW",
          requestBody: { values: rows },
        });
      }
    }
  })().catch((error) => {
    routingReady = null;
    throw error;
  });

  return routingReady;
}

type RoutingRow = {
  type: "agent" | "line";
  phone: string;
  label: string;
  enabled: boolean;
  isDefault: boolean;
  twilioSid: string;
  updatedAt: string;
  rowNumber: number;
};

async function getRoutingRows(): Promise<RoutingRow[]> {
  await ensureRoutingSheet();
  const sheets = getSheets();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: sheetRange("A2:G"),
  });

  return ((response.data.values || []) as SheetCell[][]).flatMap((row, index) => {
    const type = cell(row[0]).trim().toLowerCase();
    const phone = normalizePhone(cell(row[1]));
    if ((type !== "agent" && type !== "line") || !isRoutingPhone(phone)) return [];
    return [{
      type,
      phone,
      label: cell(row[2]).trim() || (type === "line" ? phone : "Agent"),
      enabled: booleanCell(row[3], true),
      isDefault: type === "line" && booleanCell(row[4]),
      twilioSid: cell(row[5]).trim(),
      updatedAt: cell(row[6]).trim(),
      rowNumber: index + 2,
    } as RoutingRow];
  });
}

async function loadCallRoutingConfig(): Promise<CallRoutingConfig> {
  const rows = await getRoutingRows();
  return {
    agents: rows
      .filter((row) => row.type === "agent")
      .map(({ phone, label, enabled, updatedAt }) => ({ phone, label, enabled, updatedAt })),
    lines: rows
      .filter((row) => row.type === "line")
      .map(({ phone, label, enabled, isDefault, twilioSid, updatedAt }) => ({
        phone,
        label,
        enabled,
        isDefault,
        twilioSid,
        updatedAt,
      }))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
  };
}

const getCachedCallRoutingConfig = unstable_cache(
  loadCallRoutingConfig,
  [ROUTING_CACHE_TAG],
  { revalidate: 10, tags: [ROUTING_CACHE_TAG] }
);

export async function getCallRoutingConfig(options?: {
  fresh?: boolean;
}): Promise<CallRoutingConfig> {
  return options?.fresh ? loadCallRoutingConfig() : getCachedCallRoutingConfig();
}

function invalidateCallRoutingConfig(): void {
  revalidateTag(ROUTING_CACHE_TAG, { expire: 0 });
}

async function writeRoutingRow(rowNumber: number | null, values: Array<string | boolean>): Promise<void> {
  const sheets = getSheets();
  if (rowNumber) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: sheetRange(`A${rowNumber}:G${rowNumber}`),
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: sheetRange("A:G"),
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

export async function upsertRoutingAgent(input: {
  phone: string;
  label?: string;
  enabled?: boolean;
}): Promise<CallRoutingConfig> {
  const phone = normalizePhone(input.phone);
  if (!isRoutingPhone(phone)) throw new Error("Agent phone must use E.164 format");

  const rows = await getRoutingRows();
  const existing = rows.find((row) => row.type === "agent" && row.phone === phone);
  await writeRoutingRow(existing?.rowNumber || null, [
    "agent",
    phone,
    input.label?.trim() || existing?.label || "Agent",
    input.enabled ?? existing?.enabled ?? true,
    false,
    "",
    new Date().toISOString(),
  ]);
  invalidateCallRoutingConfig();
  return loadCallRoutingConfig();
}

export async function upsertRoutingLine(input: {
  phone: string;
  label?: string;
  enabled?: boolean;
  isDefault?: boolean;
  twilioSid?: string;
}): Promise<CallRoutingConfig> {
  const phone = normalizePhone(input.phone);
  if (!isRoutingPhone(phone)) throw new Error("Twilio line must use E.164 format");

  const rows = await getRoutingRows();
  const existing = rows.find((row) => row.type === "line" && row.phone === phone);
  const lineRows = rows.filter((row) => row.type === "line");
  const isDefault = input.isDefault ?? existing?.isDefault ?? lineRows.length === 0;

  if (isDefault) {
    const sheets = getSheets();
    const updates = lineRows
      .filter((row) => row.phone !== phone && row.isDefault)
      .map((row) => ({ range: sheetRange(`E${row.rowNumber}`), values: [[false]] }));
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: spreadsheetId(),
        requestBody: { valueInputOption: "RAW", data: updates },
      });
    }
  }

  await writeRoutingRow(existing?.rowNumber || null, [
    "line",
    phone,
    input.label?.trim() || existing?.label || phone,
    input.enabled ?? existing?.enabled ?? true,
    isDefault,
    input.twilioSid || existing?.twilioSid || "",
    new Date().toISOString(),
  ]);
  invalidateCallRoutingConfig();
  return loadCallRoutingConfig();
}

export async function removeRoutingAgent(phoneValue: string): Promise<CallRoutingConfig> {
  const phone = normalizePhone(phoneValue);
  const rows = await getRoutingRows();
  const row = rows.find((item) => item.type === "agent" && item.phone === phone);
  if (!row) return getCallRoutingConfig();

  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId() });
  const sheetId = (meta.data.sheets || []).find(
    (sheet) => sheet.properties?.title === routingTab()
  )?.properties?.sheetId;
  if (sheetId === undefined) throw new Error("Call Routing sheet was not found");

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: row.rowNumber - 1,
            endIndex: row.rowNumber,
          },
        },
      }],
    },
  });
  invalidateCallRoutingConfig();
  return loadCallRoutingConfig();
}

export async function resolveOutboundLine(preferredPhone?: string): Promise<RoutingLine> {
  const config = await getCallRoutingConfig();
  const activeLines = config.lines.filter((line) => line.enabled);
  if (activeLines.length === 0) throw new Error("No active Twilio lines are configured");

  const preferred = preferredPhone ? normalizePhone(preferredPhone) : "";
  return (
    activeLines.find((line) => line.phone === preferred) ||
    activeLines.find((line) => line.isDefault) ||
    activeLines[0]
  );
}

function getTwilioClient() {
  const sid = process.env.TWILIO_SID;
  const auth = process.env.TWILIO_AUTH;
  if (!sid || !auth) throw new Error("Missing TWILIO_SID or TWILIO_AUTH");
  return twilio(sid, auth);
}

export async function configureTwilioInboundNumber(phoneValue: string): Promise<{
  sid: string;
  phone: string;
}> {
  const phone = normalizePhone(phoneValue);
  if (!isRoutingPhone(phone)) throw new Error("Twilio line must use E.164 format");

  const client = getTwilioClient();
  const matches = await client.incomingPhoneNumbers.list({ phoneNumber: phone, limit: 1 });
  const target = matches[0];
  if (!target) throw new Error(`${phone} is not owned by this Twilio account`);
  if (!target.capabilities?.voice) throw new Error(`${phone} is not voice capable`);

  const sourcePhone = normalizePhone(process.env.TWILIO_NUMBER || "");
  const sourceMatches = isRoutingPhone(sourcePhone)
    ? await client.incomingPhoneNumbers.list({ phoneNumber: sourcePhone, limit: 1 })
    : [];
  const source = sourceMatches[0];
  const voiceUrl = process.env.TWILIO_STUDIO_FLOW_URL || source?.voiceUrl || "";
  if (!voiceUrl) throw new Error("The production Twilio Studio Flow URL is not configured");

  await client.incomingPhoneNumbers(target.sid).update({
    voiceUrl,
    voiceMethod: source?.voiceMethod || "POST",
    voiceFallbackUrl: source?.voiceFallbackUrl || "",
    voiceFallbackMethod: source?.voiceFallbackMethod || "POST",
    statusCallback: source?.statusCallback || "",
    statusCallbackMethod: source?.statusCallbackMethod || "POST",
  });

  return { sid: target.sid, phone: target.phoneNumber };
}
