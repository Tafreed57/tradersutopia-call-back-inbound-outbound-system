import { revalidateTag, unstable_cache } from "next/cache";
import twilio from "twilio";
import { databaseRequest } from "./database";

const ROUTING_CACHE_TAG = "call-routing-config";

export interface RoutingAgent {
  phone: string;
  label: string;
  enabled: boolean;
  updatedAt: string;
  linePhones: string[];
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

function seedConfig(): CallRoutingConfig {
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

  return {
    lines: lines.map((phone, index) => ({
      phone,
      label: labels[index] || `Line ${index + 1}`,
      enabled: true,
      isDefault: index === 0,
      twilioSid: "",
      updatedAt: now,
    })),
    agents: agents.map((phone, index) => ({
      phone,
      label: `Agent ${index + 1}`,
      enabled: true,
      updatedAt: now,
      linePhones: [],
    })),
  };
}

async function loadCallRoutingConfig(): Promise<CallRoutingConfig> {
  let config = await databaseRequest<CallRoutingConfig>("routing.get");
  if (config.lines.length > 0 || config.agents.length > 0) return config;

  const seed = seedConfig();
  for (const line of seed.lines) {
    config = await databaseRequest<CallRoutingConfig>("routing.upsert_line", line);
  }
  for (const agent of seed.agents) {
    config = await databaseRequest<CallRoutingConfig>("routing.upsert_agent", agent);
  }
  return config;
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

export async function upsertRoutingAgent(input: {
  phone: string;
  label?: string;
  enabled?: boolean;
  linePhones?: string[];
}): Promise<CallRoutingConfig> {
  const phone = normalizePhone(input.phone);
  if (!isRoutingPhone(phone)) throw new Error("Agent phone must use E.164 format");

  const config = await getCallRoutingConfig({ fresh: true });
  const configuredLines = new Set(config.lines.map((line) => line.phone));
  const linePhones = input.linePhones?.map(normalizePhone);
  if (linePhones?.some((linePhone) => !configuredLines.has(linePhone))) {
    throw new Error("Agent assignments must use configured Twilio lines");
  }

  const result = await databaseRequest<CallRoutingConfig>("routing.upsert_agent", {
    ...input,
    phone,
    ...(linePhones ? { linePhones: [...new Set(linePhones)] } : {}),
  });
  invalidateCallRoutingConfig();
  return result;
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

  const config = await getCallRoutingConfig({ fresh: true });
  const existing = config.lines.find((line) => line.phone === phone);
  const result = await databaseRequest<CallRoutingConfig>("routing.upsert_line", {
    ...input,
    phone,
    isDefault: input.isDefault ?? existing?.isDefault ?? config.lines.length === 0,
  });
  invalidateCallRoutingConfig();
  return result;
}

export async function removeRoutingAgent(phoneValue: string): Promise<CallRoutingConfig> {
  const result = await databaseRequest<CallRoutingConfig>("routing.remove_agent", {
    phone: normalizePhone(phoneValue),
  });
  invalidateCallRoutingConfig();
  return result;
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
