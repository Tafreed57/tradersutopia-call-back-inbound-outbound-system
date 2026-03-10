import { NextRequest, NextResponse } from "next/server";
import { savePushSubscription } from "@/lib/sheets";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { endpoint, keys } = body;

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return NextResponse.json(
        { ok: false, error: "Invalid subscription object" },
        { status: 400 }
      );
    }

    await savePushSubscription({ endpoint, keys });
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/push/subscribe]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
