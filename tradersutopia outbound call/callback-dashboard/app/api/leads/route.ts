/**
 * GET /api/leads
 * Query params: status, q, sort, order
 * Server-only — reads from Google Sheets
 */

import { NextRequest, NextResponse } from "next/server";
import { getLeads, ensureSheetsReady } from "@/lib/sheets";
import { withRetry } from "@/lib/retry";
import { validateAccessCode } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl;
    const status = url.searchParams.get("status") || "all";
    const q = url.searchParams.get("q") || "";
    const sort = url.searchParams.get("sort") || "createdAt";
    const order = url.searchParams.get("order") || "desc";
    const auth = validateAccessCode(
      url.searchParams.get("accessCode") || req.headers.get("x-access-code")
    );

    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.error },
        { status: auth.status }
      );
    }

    await ensureSheetsReady();

    const leads = await withRetry(() => getLeads({ status, q, sort, order }));
    return NextResponse.json(
      { ok: true, leads },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GET /api/leads] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
