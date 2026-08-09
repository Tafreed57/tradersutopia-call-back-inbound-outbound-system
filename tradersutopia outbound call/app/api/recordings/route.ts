import { NextRequest, NextResponse } from "next/server";
import { validateAccessCode } from "@/lib/access";
import { listCallRecordings } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const auth = validateAccessCode(
      req.nextUrl.searchParams.get("accessCode") || req.headers.get("x-access-code")
    );
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.error },
        { status: auth.status }
      );
    }

    const limitRaw = Number(req.nextUrl.searchParams.get("limit") || "50");
    const daysRaw = Number(req.nextUrl.searchParams.get("days") || "7");
    const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(daysRaw, 31)) : 7;
    const recordings = await listCallRecordings(
      Number.isFinite(limitRaw) ? limitRaw : 50,
      days
    );

    return NextResponse.json(
      { ok: true, recordings, windowDays: days },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GET /api/recordings] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
