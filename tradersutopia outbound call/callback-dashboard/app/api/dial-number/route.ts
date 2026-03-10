/**
 * POST /api/dial-number
 * Manual dial: any number (not from the lead list). Emergency numbers are blocked.
 * Body: { affiliatePhone, leadPhone, accessCode }
 */

import { NextRequest, NextResponse } from "next/server";
import { startBridgeCall, isE164 } from "@/lib/twilio";
import { isEmergencyNumber } from "@/lib/emergency";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { affiliatePhone, leadPhone, accessCode } = body;

    if (accessCode !== process.env.AFFILIATE_ACCESS_CODE) {
      return NextResponse.json(
        { ok: false, error: "Invalid access code" },
        { status: 401 }
      );
    }

    if (!affiliatePhone || !leadPhone) {
      return NextResponse.json(
        { ok: false, error: "Missing affiliatePhone or leadPhone" },
        { status: 400 }
      );
    }

    // Normalize: strip non-digits (except leading +), then add country code if needed
    let normalizedLead = leadPhone.trim();
    if (!normalizedLead.startsWith("+")) {
      const digits = normalizedLead.replace(/\D/g, "");
      if (digits.length === 10) {
        // 10-digit US/Canada number → add +1
        normalizedLead = `+1${digits}`;
      } else if (digits.length === 11 && digits.startsWith("1")) {
        // 11-digit with leading 1 → add +
        normalizedLead = `+${digits}`;
      } else {
        normalizedLead = `+${digits}`;
      }
    }

    if (!isE164(normalizedLead)) {
      return NextResponse.json(
        { ok: false, error: "Lead number must be E.164 format (e.g. +15551234567)" },
        { status: 400 }
      );
    }

    if (!isE164(affiliatePhone)) {
      return NextResponse.json(
        { ok: false, error: "Affiliate number must be E.164 format" },
        { status: 400 }
      );
    }

    if (isEmergencyNumber(normalizedLead)) {
      return NextResponse.json(
        { ok: false, error: "Emergency and special service numbers cannot be called." },
        { status: 400 }
      );
    }

    const { getPublicBaseUrl } = await import("@/lib/base-url");
    const publicBaseUrl = getPublicBaseUrl(req.headers.get("host"));

    console.log("[dial-number] PUBLIC_BASE_URL:", publicBaseUrl ? `${publicBaseUrl.slice(0, 40)}...` : "(not set)");

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

    const { callSid } = await startBridgeCall({
      affiliatePhone,
      leadPhone: normalizedLead,
      leadId: "manual",
      publicBaseUrl,
    });

    console.log(`[dial-number] Manual dial: ${affiliatePhone} → ${normalizedLead}`);
    return NextResponse.json({ ok: true, callSid });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/dial-number] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
