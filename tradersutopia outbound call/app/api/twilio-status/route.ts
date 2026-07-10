import { NextRequest, NextResponse } from "next/server";
import { appendLog, ensureSheetsReady } from "@/lib/sheets";
import { v4 as uuidv4 } from "uuid";

export const runtime = "nodejs";

async function readTwilioPayload(req: NextRequest): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const json = await req.json().catch(() => ({}));
    return Object.fromEntries(
      Object.entries(json).map(([key, value]) => [key, String(value ?? "")])
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) return {};

  return Object.fromEntries(
    [...form.entries()].map(([key, value]) => [key, String(value)])
  );
}

export async function POST(req: NextRequest) {
  const search = req.nextUrl.searchParams;
  const payload = await readTwilioPayload(req);

  const leg = search.get("leg") || payload.leg || "unknown";
  const leadId = search.get("leadId") || payload.leadId || "manual";
  const affiliatePhone = search.get("affiliatePhone") || payload.affiliatePhone || "";
  const leadPhone = search.get("lead") || payload.lead || "";
  const callStatus = payload.CallStatus || payload.CallStatusCallbackEvent || "unknown";
  const callSid = payload.CallSid || "";

  const details = {
    leg,
    callStatus,
    callSid,
    parentCallSid: payload.ParentCallSid || "",
    to: payload.To || "",
    from: payload.From || "",
    leadPhone,
    errorCode: payload.ErrorCode || "",
    errorMessage: payload.ErrorMessage || "",
    sipResponseCode: payload.SipResponseCode || "",
    callDuration: payload.CallDuration || payload.Duration || "",
    timestamp: new Date().toISOString(),
  };

  console.log("[twilio-status]", JSON.stringify(details));

  try {
    await ensureSheetsReady();
    await appendLog({
      logId: uuidv4(),
      action: `TWILIO_${leg.toUpperCase()}_${callStatus.toUpperCase()}`,
      leadId,
      affiliatePhone,
      details: JSON.stringify(details),
      twilioCallSid: callSid,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.warn("[twilio-status] Log skipped:", message);
  }

  return new NextResponse(null, { status: 204 });
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "twilio-status" });
}
