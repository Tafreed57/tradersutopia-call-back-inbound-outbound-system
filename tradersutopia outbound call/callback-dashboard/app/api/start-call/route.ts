/**
 * POST /api/start-call
 * Body: { leadId, affiliatePhone, accessCode }
 * Initiates a Twilio bridge call, updates Sheets, logs to CallLogs.
 */

import { NextRequest, NextResponse } from "next/server";
import { getLeadById, appendLog, ensureSheetsReady } from "@/lib/sheets";
import { startBridgeCall, isE164 } from "@/lib/twilio";
import { isEmergencyNumber } from "@/lib/emergency";
import { v4 as uuidv4 } from "uuid";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    await ensureSheetsReady();

    const body = await req.json();
    const { leadId, affiliatePhone, accessCode } = body;

    // ── Auth ──
    if (accessCode !== process.env.AFFILIATE_ACCESS_CODE) {
      return NextResponse.json(
        { ok: false, error: "Invalid access code" },
        { status: 401 }
      );
    }

    // ── Validate ──
    if (!leadId || !affiliatePhone) {
      return NextResponse.json(
        { ok: false, error: "Missing leadId or affiliatePhone" },
        { status: 400 }
      );
    }

    if (!isE164(affiliatePhone)) {
      return NextResponse.json(
        { ok: false, error: "affiliatePhone must be E.164 format (e.g. +15551234567)" },
        { status: 400 }
      );
    }

    // ── Look up lead ──
    const lead = await getLeadById(leadId);
    if (!lead) {
      return NextResponse.json(
        { ok: false, error: "Lead not found" },
        { status: 404 }
      );
    }

    if (!lead.phone || !isE164(lead.phone)) {
      return NextResponse.json(
        { ok: false, error: `Lead phone is missing or invalid: ${lead.phone}` },
        { status: 400 }
      );
    }

    if (isEmergencyNumber(lead.phone)) {
      return NextResponse.json(
        { ok: false, error: "Emergency and special service numbers cannot be called." },
        { status: 400 }
      );
    }

    // ── Determine public base URL ──
    const { getPublicBaseUrl } = await import("@/lib/base-url");
    const publicBaseUrl = getPublicBaseUrl(req.headers.get("host"));
    console.log(`[start-call] publicBaseUrl=${publicBaseUrl}, VERCEL_URL=${process.env.VERCEL_URL || "(not set)"}, host=${req.headers.get("host")}`);

    if (!publicBaseUrl || publicBaseUrl.includes("localhost")) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Twilio cannot reach localhost. Set PUBLIC_BASE_URL in .env.local to your ngrok URL (e.g. https://xxxx.ngrok-free.app) and restart the server.",
        },
        { status: 400 }
      );
    }

    console.log(`[start-call] Affiliate: ${affiliatePhone} → Lead: ${lead.phone} (${lead.name})`);

    // ── Initiate Twilio bridge call ──
    const { callSid } = await startBridgeCall({
      affiliatePhone,
      leadPhone: lead.phone,
      leadId: lead.id,
      publicBaseUrl,
    });

    console.log(`[start-call] Call created: ${callSid}`);

    // Log the call attempt (but do NOT change status — agent must manually "Mark Called")
    await appendLog({
      logId: uuidv4(),
      action: "CALL_DIALED",
      leadId: lead.id,
      affiliatePhone,
      details: JSON.stringify({ leadName: lead.name, leadPhone: lead.phone }),
      twilioCallSid: callSid,
    });

    return NextResponse.json({ ok: true, callSid });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/start-call] Error:", message);

    // Log the error
    try {
      await appendLog({
        logId: uuidv4(),
        action: "ERROR",
        leadId: (await req.clone().json()).leadId || "unknown",
        affiliatePhone: (await req.clone().json()).affiliatePhone || "unknown",
        details: message,
      });
    } catch {
      // Best effort logging
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
