/**
 * PATCH /api/leads/[id]
 * Body: { status?, notes?, accessCode }
 * Updates a lead and appends to CallLogs.
 */

import { NextRequest, NextResponse } from "next/server";
import { updateLead, appendLog, ensureSheetsReady } from "@/lib/sheets";
import { withRetry } from "@/lib/retry";
import { v4 as uuidv4 } from "uuid";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureSheetsReady();

    const { id } = await params;
    const body = await req.json();
    const { status, notes, accessCode } = body;

    // Auth check
    if (accessCode !== process.env.AFFILIATE_ACCESS_CODE) {
      return NextResponse.json(
        { ok: false, error: "Invalid access code" },
        { status: 401 }
      );
    }

    if (!status && notes === undefined) {
      return NextResponse.json(
        { ok: false, error: "Nothing to update. Send status and/or notes." },
        { status: 400 }
      );
    }

    const patch: Record<string, string> = {};
    if (status) patch.status = status;
    if (notes !== undefined) patch.notes = notes;
    if (status === "called") {
      patch.calledAt = new Date().toISOString();
      if (body.affiliatePhone) patch.calledBy = body.affiliatePhone;
    }

    const updated = await withRetry(() => updateLead(id, patch));
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: "Lead not found" },
        { status: 404 }
      );
    }

    // Determine log action
    let action = "NOTE_UPDATED";
    if (status === "called") action = "MARK_CALLED";
    else if (status === "pending") action = "MARK_PENDING";
    else if (status) action = `STATUS_${status.toUpperCase()}`;

    await withRetry(() => appendLog({
      logId: uuidv4(),
      action,
      leadId: id,
      affiliatePhone: body.affiliatePhone || "",
      details: JSON.stringify({ status, notes: notes?.slice(0, 100) }),
    }));

    return NextResponse.json({ ok: true, lead: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[PATCH /api/leads/${(await params).id}] Error:`, message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
