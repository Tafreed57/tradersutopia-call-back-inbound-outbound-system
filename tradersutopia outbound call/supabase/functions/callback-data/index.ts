import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.2";

const EXPECTED_SECRET_HASH =
  "1dd4a0d66f71e1abb50ad58127763ecc297570c8203ac23a5d8ad9dd1ca13476";

const db = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type JsonRecord = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function authorized(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") || "";
  const secret = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return Boolean(secret) && (await sha256(secret)) === EXPECTED_SECRET_HASH;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function phone(value: unknown): string {
  const raw = text(value).trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return `+${digits.length === 10 ? `1${digits}` : digits}`;
}

function phoneKey(value: unknown): string {
  return phone(value).replace(/\D/g, "");
}

function timestamp(value: unknown, fallback: string | null = null): string | null {
  if (value === null || value === undefined || value === "") return fallback;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function fail(error: { message?: string } | null): void {
  if (error) throw new Error(error.message || "Database request failed");
}

function leadFromRow(row: JsonRecord): JsonRecord {
  return {
    id: text(row.id),
    createdAt: text(row.created_at),
    name: text(row.name),
    phone: text(row.phone),
    reason: text(row.reason),
    status: text(row.status) || "pending",
    calledAt: text(row.called_at),
    calledBy: text(row.called_by),
    notes: text(row.notes),
    lastUpdatedAt: text(row.last_updated_at),
    calledNumber: text(row.called_number),
  };
}

function recordingFavoriteFromRow(row: JsonRecord): JsonRecord {
  return {
    favoritedAt: text(row.favorited_at),
    recording: asRecord(row.recording),
  };
}

function liveCallFromRow(row: JsonRecord): JsonRecord {
  return {
    agentNumber: text(row.agent_number),
    conferenceName: text(row.conference_name),
    callerNumber: text(row.caller_number),
    startTime: text(row.start_time),
    status: text(row.status),
    callDuration: text(row.call_duration),
    endTime: text(row.end_time),
  };
}

async function routingConfig(): Promise<JsonRecord> {
  const [linesResult, agentsResult, assignmentsResult] = await Promise.all([
    db.from("callback_routing_lines").select("*").order("is_default", { ascending: false }),
    db.from("callback_routing_agents").select("*").order("label"),
    db.from("callback_routing_agent_lines").select("agent_phone,line_phone"),
  ]);
  fail(linesResult.error);
  fail(agentsResult.error);
  fail(assignmentsResult.error);

  const assignments = new Map<string, string[]>();
  for (const row of assignmentsResult.data || []) {
    const current = assignments.get(row.agent_phone) || [];
    current.push(row.line_phone);
    assignments.set(row.agent_phone, current);
  }

  return {
    lines: (linesResult.data || []).map((row) => ({
      phone: row.phone,
      label: row.label,
      enabled: row.enabled,
      isDefault: row.is_default,
      twilioSid: row.twilio_sid,
      updatedAt: row.updated_at,
    })),
    agents: (agentsResult.data || []).map((row) => ({
      phone: row.phone,
      label: row.label,
      enabled: row.enabled,
      updatedAt: row.updated_at,
      linePhones: assignments.get(row.phone) || [],
    })),
  };
}

async function handle(action: string, payload: JsonRecord): Promise<unknown> {
  if (action === "health") {
    const result = await db.from("callback_leads").select("id", { count: "exact", head: true });
    fail(result.error);
    return { backend: "postgres", leadCount: result.count || 0 };
  }

  if (action === "leads.list") {
    const result = await db.from("callback_leads").select("*").limit(5000);
    fail(result.error);
    let leads = (result.data || []).map((row) => leadFromRow(row));
    const status = text(payload.status);
    const q = text(payload.q).toLowerCase();
    if (status && status !== "all") leads = leads.filter((lead) => lead.status === status);
    if (q) {
      leads = leads.filter((lead) =>
        text(lead.name).toLowerCase().includes(q) || text(lead.phone).includes(q)
      );
    }
    const sort = ["createdAt", "lastUpdatedAt", "calledAt", "name", "phone", "status"]
      .includes(text(payload.sort)) ? text(payload.sort) : "createdAt";
    const direction = text(payload.order) === "asc" ? 1 : -1;
    leads.sort((left, right) => {
      const a = text(left[sort]);
      const b = text(right[sort]);
      const aDate = sort.endsWith("At") ? Date.parse(a) || 0 : 0;
      const bDate = sort.endsWith("At") ? Date.parse(b) || 0 : 0;
      return direction * (aDate || bDate ? aDate - bDate : a.localeCompare(b));
    });
    return leads;
  }

  if (action === "leads.get") {
    const result = await db.from("callback_leads").select("*").eq("id", text(payload.id)).maybeSingle();
    fail(result.error);
    return result.data ? leadFromRow(result.data) : null;
  }

  if (action === "leads.update") {
    const patch = asRecord(payload.patch);
    const updates: JsonRecord = { last_updated_at: new Date().toISOString() };
    if (patch.status !== undefined) updates.status = text(patch.status);
    if (patch.notes !== undefined) updates.notes = text(patch.notes);
    if (patch.calledBy !== undefined) updates.called_by = text(patch.calledBy);
    if (patch.calledAt !== undefined) updates.called_at = timestamp(patch.calledAt);
    const result = await db.from("callback_leads").update(updates).eq("id", text(payload.id)).select("*").maybeSingle();
    fail(result.error);
    return result.data ? leadFromRow(result.data) : null;
  }

  if (action === "leads.upsert_missed") {
    const normalizedPhone = phone(payload.phone);
    if (!normalizedPhone) throw new Error("A valid caller phone is required");
    const now = timestamp(payload.createdAt, new Date().toISOString()) as string;
    const callSid = text(payload.callSid) || crypto.randomUUID();
    const row = {
      id: callSid,
      phone: normalizedPhone,
      phone_key: phoneKey(normalizedPhone),
      created_at: now,
      name: text(payload.name) || "Lead (missed inbound)",
      reason: text(payload.reason) || "missed_inbound",
      status: "pending",
      called_at: null,
      called_by: "",
      notes: text(payload.notes),
      last_updated_at: now,
      called_number: phone(payload.calledNumber),
      source_call_sid: callSid,
      digits: text(payload.digits),
    };
    const result = await db.from("callback_leads").upsert(row, { onConflict: "phone_key" }).select("*").single();
    fail(result.error);
    return leadFromRow(result.data);
  }

  if (action === "logs.append") {
    const entry = asRecord(payload.entry);
    const result = await db.from("callback_call_logs").upsert({
      log_id: text(entry.logId) || crypto.randomUUID(),
      created_at: timestamp(entry.timestamp, new Date().toISOString()),
      lead_id: text(entry.leadId),
      action: text(entry.action),
      affiliate_phone: text(entry.affiliatePhone),
      details: text(entry.details),
      twilio_call_sid: text(entry.twilioCallSid),
    }, { onConflict: "log_id" });
    fail(result.error);
    return null;
  }

  if (action === "favorites.list") {
    const result = await db.from("callback_recording_favorites").select("*").order("favorited_at", { ascending: false });
    fail(result.error);
    return (result.data || []).map((row) => recordingFavoriteFromRow(row));
  }

  if (action === "favorites.save") {
    const recording = asRecord(payload.recording);
    const recordingSid = text(recording.sid);
    const existing = await db.from("callback_recording_favorites").select("favorited_at").eq("recording_sid", recordingSid).maybeSingle();
    fail(existing.error);
    const favoritedAt = existing.data?.favorited_at || new Date().toISOString();
    const result = await db.from("callback_recording_favorites").upsert({
      recording_sid: recordingSid,
      favorited_at: favoritedAt,
      recording,
    }, { onConflict: "recording_sid" });
    fail(result.error);
    return { recording, favoritedAt };
  }

  if (action === "favorites.remove") {
    const result = await db.from("callback_recording_favorites").delete().eq("recording_sid", text(payload.recordingSid));
    fail(result.error);
    return null;
  }

  if (action === "live_calls.list") {
    let query = db.from("callback_live_calls").select("*").order("start_time", { ascending: false });
    const status = text(payload.status);
    if (status && status !== "all") query = query.eq("status", status);
    const result = await query;
    fail(result.error);
    return (result.data || []).map((row) => liveCallFromRow(row));
  }

  if (action === "live_calls.upsert") {
    const call = asRecord(payload.call);
    const result = await db.from("callback_live_calls").upsert({
      agent_number: phone(call.agentNumber),
      conference_name: text(call.conferenceName),
      caller_number: phone(call.callerNumber),
      start_time: timestamp(call.startTime),
      status: text(call.status) === "ENDED" ? "ENDED" : "LIVE",
      call_duration: text(call.callDuration),
      end_time: timestamp(call.endTime),
      updated_at: new Date().toISOString(),
    }, { onConflict: "agent_number,conference_name" });
    fail(result.error);
    return null;
  }

  if (action === "live_calls.end") {
    const result = await db.from("callback_live_calls").update({
      status: "ENDED",
      call_duration: text(payload.callDuration),
      end_time: timestamp(payload.endTime, new Date().toISOString()),
      updated_at: new Date().toISOString(),
    })
      .eq("agent_number", phone(payload.agentNumber))
      .eq("conference_name", text(payload.conferenceName));
    fail(result.error);
    return null;
  }

  if (action === "push_subscriptions.list") {
    const result = await db.from("callback_push_subscriptions").select("*");
    fail(result.error);
    return (result.data || []).map((row) => ({
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
      createdAt: row.created_at,
    }));
  }

  if (action === "push_subscriptions.save") {
    const sub = asRecord(payload.subscription);
    const keys = asRecord(sub.keys);
    const result = await db.from("callback_push_subscriptions").upsert({
      endpoint: text(sub.endpoint),
      p256dh: text(keys.p256dh),
      auth: text(keys.auth),
      created_at: new Date().toISOString(),
    }, { onConflict: "endpoint" });
    fail(result.error);
    return null;
  }

  if (action === "push_subscriptions.remove") {
    const result = await db.from("callback_push_subscriptions").delete().eq("endpoint", text(payload.endpoint));
    fail(result.error);
    return null;
  }

  if (action === "push_notified.recent") {
    const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const result = await db.from("callback_push_notified").select("agent_number,conference_name").gte("notified_at", since);
    fail(result.error);
    return (result.data || []).map((row) => `${row.agent_number}::${row.conference_name}`);
  }

  if (action === "push_notified.record") {
    const result = await db.from("callback_push_notified").upsert({
      agent_number: phone(payload.agentNumber),
      conference_name: text(payload.conferenceName),
      notified_at: new Date().toISOString(),
    }, { onConflict: "agent_number,conference_name" });
    fail(result.error);
    return null;
  }

  if (action === "routing.get") return await routingConfig();

  if (action === "routing.upsert_agent") {
    const normalizedPhone = phone(payload.phone);
    const existingResult = await db.from("callback_routing_agents").select("*").eq("phone", normalizedPhone).maybeSingle();
    fail(existingResult.error);
    const existing = existingResult.data;
    const agentResult = await db.from("callback_routing_agents").upsert({
      phone: normalizedPhone,
      label: text(payload.label) || existing?.label || "Agent",
      enabled: payload.enabled === undefined ? existing?.enabled ?? true : bool(payload.enabled),
      updated_at: new Date().toISOString(),
    }, { onConflict: "phone" });
    fail(agentResult.error);
    if (Array.isArray(payload.linePhones)) {
      const removeResult = await db.from("callback_routing_agent_lines").delete().eq("agent_phone", normalizedPhone);
      fail(removeResult.error);
      const lines = [...new Set(payload.linePhones.map(phone).filter(Boolean))];
      if (lines.length) {
        const insertResult = await db.from("callback_routing_agent_lines").insert(
          lines.map((linePhone) => ({ agent_phone: normalizedPhone, line_phone: linePhone })),
        );
        fail(insertResult.error);
      }
    }
    return await routingConfig();
  }

  if (action === "routing.upsert_line") {
    const normalizedPhone = phone(payload.phone);
    const existingResult = await db.from("callback_routing_lines").select("*").eq("phone", normalizedPhone).maybeSingle();
    fail(existingResult.error);
    const existing = existingResult.data;
    const isDefault = payload.isDefault === undefined ? existing?.is_default ?? false : bool(payload.isDefault);
    if (isDefault) {
      const clearResult = await db.from("callback_routing_lines").update({ is_default: false }).neq("phone", normalizedPhone);
      fail(clearResult.error);
    }
    const result = await db.from("callback_routing_lines").upsert({
      phone: normalizedPhone,
      label: text(payload.label) || existing?.label || normalizedPhone,
      enabled: payload.enabled === undefined ? existing?.enabled ?? true : bool(payload.enabled),
      is_default: isDefault,
      twilio_sid: text(payload.twilioSid) || existing?.twilio_sid || "",
      updated_at: new Date().toISOString(),
    }, { onConflict: "phone" });
    fail(result.error);
    return await routingConfig();
  }

  if (action === "routing.remove_agent") {
    const result = await db.from("callback_routing_agents").delete().eq("phone", phone(payload.phone));
    fail(result.error);
    return await routingConfig();
  }

  if (action === "import.batch") {
    const table = text(payload.table);
    const rows = Array.isArray(payload.rows) ? payload.rows.map(asRecord) : [];
    if (!rows.length) return { imported: 0 };
    const config: Record<string, { name: string; conflict: string }> = {
      leads: { name: "callback_leads", conflict: "phone_key" },
      logs: { name: "callback_call_logs", conflict: "log_id" },
      favorites: { name: "callback_recording_favorites", conflict: "recording_sid" },
      liveCalls: { name: "callback_live_calls", conflict: "agent_number,conference_name" },
      pushSubscriptions: { name: "callback_push_subscriptions", conflict: "endpoint" },
      pushNotified: { name: "callback_push_notified", conflict: "agent_number,conference_name" },
      routingLines: { name: "callback_routing_lines", conflict: "phone" },
      routingAgents: { name: "callback_routing_agents", conflict: "phone" },
      routingAssignments: { name: "callback_routing_agent_lines", conflict: "agent_phone,line_phone" },
    };
    const target = config[table];
    if (!target) throw new Error("Unsupported import table");
    const result = await db.from(target.name).upsert(rows, { onConflict: target.conflict });
    fail(result.error);
    return { imported: rows.length };
  }

  throw new Error("Unsupported database action");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!(await authorized(req))) return json({ ok: false, error: "Unauthorized" }, 401);

  try {
    const body = asRecord(await req.json());
    const action = text(body.action);
    const data = await handle(action, asRecord(body.payload));
    return json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database request failed";
    console.error("[callback-data]", message);
    return json({ ok: false, error: message }, 400);
  }
});
