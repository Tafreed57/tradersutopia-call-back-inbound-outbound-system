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

  const source = search.get("source") || payload.RecordingSource || "recording";
  const leadId = search.get("leadId") || payload.leadId || "manual";
  const affiliatePhone = search.get("affiliatePhone") || payload.affiliatePhone || "";
  const recordingStatus = payload.RecordingStatus || "unknown";
  const recordingSid = payload.RecordingSid || "";
  const callSid = payload.CallSid || "";

  const details = {
    source,
    recordingStatus,
    recordingSid,
    recordingUrl: payload.RecordingUrl || "",
    recordingDuration: payload.RecordingDuration || "",
    recordingChannels: payload.RecordingChannels || "",
    recordingStartTime: payload.RecordingStartTime || "",
    recordingSource: payload.RecordingSource || "",
    callSid,
    conferenceSid: payload.ConferenceSid || "",
    leadPhone: search.get("lead") || payload.lead || "",
    timestamp: new Date().toISOString(),
  };

  console.log("[recording-status]", JSON.stringify(details));

  try {
    await ensureSheetsReady();
    await appendLog({
      logId: uuidv4(),
      action: `RECORDING_${recordingStatus.toUpperCase()}`,
      leadId,
      affiliatePhone,
      details: JSON.stringify(details),
      twilioCallSid: callSid || recordingSid,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.warn("[recording-status] Log skipped:", message);
  }

  return new NextResponse(null, { status: 204 });
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "recording-status" });
}
