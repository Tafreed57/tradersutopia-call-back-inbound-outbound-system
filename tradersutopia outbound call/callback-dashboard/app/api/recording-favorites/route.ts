import { NextRequest, NextResponse } from "next/server";
import { validateAccessCode } from "@/lib/access";
import {
  removeRecordingFavorite,
  saveRecordingFavorite,
} from "@/lib/data-store";
import type { CallRecording } from "@/lib/twilio";
import { withRetry } from "@/lib/retry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auth = validateAccessCode(body.accessCode);
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.error },
        { status: auth.status }
      );
    }

    const recordingSid = stringValue(
      body.recordingSid || body.recording?.sid
    );
    if (!/^RE[0-9a-fA-F]{32}$/.test(recordingSid)) {
      return NextResponse.json(
        { ok: false, error: "Invalid recording SID" },
        { status: 400 }
      );
    }

    if (body.favorite === true) {
      const recording = normalizeRecording(body.recording);
      if (!recording || recording.sid !== recordingSid) {
        return NextResponse.json(
          { ok: false, error: "Invalid recording details" },
          { status: 400 }
        );
      }

      const saved = await withRetry(() =>
        saveRecordingFavorite(recording)
      );
      return NextResponse.json({
        ok: true,
        isFavorite: true,
        favoritedAt: saved.favoritedAt,
      });
    }

    if (body.favorite === false) {
      await withRetry(() => removeRecordingFavorite(recordingSid));
      return NextResponse.json({ ok: true, isFavorite: false });
    }

    return NextResponse.json(
      { ok: false, error: "Missing favorite state" },
      { status: 400 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/recording-favorites] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

function normalizeRecording(value: unknown): CallRecording | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const sid = stringValue(row.sid);
  if (!/^RE[0-9a-fA-F]{32}$/.test(sid)) return null;

  const verificationRaw = stringValue(row.verification);
  const verification: CallRecording["verification"] =
    verificationRaw === "conference-bridge" ||
    verificationRaw === "human-detected" ||
    verificationRaw === "connected-duration"
      ? verificationRaw
      : "connected-duration";

  return {
    sid,
    callSid: stringValue(row.callSid),
    conferenceSid: stringValue(row.conferenceSid),
    conferenceName: stringValue(row.conferenceName),
    status: stringValue(row.status),
    dateCreated: stringValue(row.dateCreated),
    duration: stringValue(row.duration),
    channels: numberValue(row.channels),
    source: stringValue(row.source),
    from: stringValue(row.from),
    to: stringValue(row.to),
    direction: stringValue(row.direction),
    callStatus: stringValue(row.callStatus),
    startTime: stringValue(row.startTime),
    endTime: stringValue(row.endTime),
    customerPhone: stringValue(row.customerPhone),
    agentPhone: stringValue(row.agentPhone),
    answeredBy: stringValue(row.answeredBy),
    connectedDuration: numberValue(row.connectedDuration),
    verification,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 500) : "";
}

function numberValue(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
