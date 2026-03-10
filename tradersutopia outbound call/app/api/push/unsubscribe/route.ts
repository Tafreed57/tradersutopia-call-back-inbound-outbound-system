import { NextRequest, NextResponse } from "next/server";
import { removePushSubscription } from "@/lib/sheets";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { endpoint } = body;

    if (!endpoint) {
      return NextResponse.json(
        { ok: false, error: "Missing endpoint" },
        { status: 400 }
      );
    }

    await removePushSubscription(endpoint);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/push/unsubscribe]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
