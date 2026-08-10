import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { databaseRequest } from "@/lib/database";
import { upsertMissedCall } from "@/lib/data-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hasValidSecret(req: NextRequest): boolean {
  const expected = process.env.CALL_ROUTING_SECRET || "";
  const supplied = req.headers.get("x-call-routing-secret") || "";
  if (!expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function value(row: Record<string, unknown>, key: string): string {
  const item = row[key];
  return item === null || item === undefined ? "" : String(item).trim();
}

export async function POST(req: NextRequest) {
  if (!hasValidSecret(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const event = value(body, "event");

    if (event === "callback_requested") {
      if (value(body, "digits") !== "missed_no_agent") {
        return NextResponse.json({ ok: true, ignored: "not_a_missed_call" });
      }
      const lead = await upsertMissedCall({
        phone: value(body, "caller"),
        calledNumber: value(body, "called_number"),
        callSid: value(body, "call_sid"),
        createdAt: value(body, "timestamp"),
        digits: value(body, "digits"),
        reason: "missed_inbound",
      });
      return NextResponse.json({ ok: true, leadId: lead.id });
    }

    if (event === "agent_on_call") {
      await databaseRequest("live_calls.upsert", {
        call: {
          agentNumber: value(body, "agent"),
          conferenceName: value(body, "conference_name"),
          callerNumber: value(body, "caller_number"),
          startTime: value(body, "timestamp"),
          status: "LIVE",
          callDuration: "",
          endTime: "",
        },
      });
      return NextResponse.json({ ok: true });
    }

    if (event === "agent_call_ended") {
      await databaseRequest("live_calls.end", {
        agentNumber: value(body, "agent"),
        conferenceName: value(body, "conference_name"),
        callDuration: value(body, "call_duration"),
        endTime: value(body, "timestamp"),
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true, ignored: "unsupported_event" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database write failed";
    console.error("[POST /api/twilio-data]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
