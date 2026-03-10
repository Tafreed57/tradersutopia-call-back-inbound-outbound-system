/**
 * GET /api/live-calls
 * Query params: status (LIVE | ENDED | all, default: LIVE)
 * Returns current live/ended call entries from the "Live Calls" sheet.
 *
 * Detects NEW live calls and sends push notifications. Uses "Push Notified"
 * sheet to track which agent+conference we already notified (works across
 * serverless invocations). We AWAIT the push so it completes before response.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getLiveCalls,
  ensureSheetsReady,
  getAllPushSubscriptions,
  removePushSubscription,
  getAlreadyNotifiedRecent,
  recordPushNotified,
  type LiveCall,
} from "@/lib/sheets";
import { withRetry } from "@/lib/retry";
import webpush from "web-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VAPID_PUBLIC =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
  process.env.VAPID_PUBLIC_KEY ||
  "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:admin@tradersutopia.com";

function callKey(c: LiveCall): string {
  return `${c.agentNumber}::${c.conferenceName}`;
}

async function sendPushForNewCalls(liveCalls: LiveCall[]): Promise<void> {
  console.log(
    `[push] enter: ${liveCalls.length} LIVE call(s), VAPID_PUB=${VAPID_PUBLIC ? "yes(" + VAPID_PUBLIC.length + ")" : "MISSING"}, VAPID_PRIV=${VAPID_PRIVATE ? "yes" : "MISSING"}`
  );

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.log("[push] ABORT: VAPID keys not configured");
    return;
  }

  let alreadyNotified: Set<string>;
  try {
    alreadyNotified = await getAlreadyNotifiedRecent();
  } catch (err) {
    console.error("[push] Failed to read notified sheet:", err);
    alreadyNotified = new Set();
  }

  const newCalls = liveCalls.filter((c) => !alreadyNotified.has(callKey(c)));
  console.log(
    `[push] notified=${alreadyNotified.size}, new=${newCalls.length}` +
      (newCalls.length === 0 && liveCalls.length > 0
        ? ` (all ${liveCalls.length} already notified)`
        : "")
  );
  if (newCalls.length === 0) return;

  let subs;
  try {
    subs = await getAllPushSubscriptions();
  } catch (err) {
    console.error("[push] Failed to read subscriptions:", err);
    return;
  }

  console.log(`[push] ${subs.length} subscriber(s)`);
  if (subs.length === 0) return;

  try {
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (err) {
    console.error("[push] VAPID config error:", err);
    return;
  }

  for (const call of newCalls) {
    const ts = call.startTime ? new Date(call.startTime) : new Date();
    const timeStr = ts.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Toronto",
    });

    const payload = JSON.stringify({
      title: "Inbound Call Taken",
      body: `Agent ${call.agentNumber} took a call at ${timeStr} ET`,
      url: "/dashboard",
      tag: "tu-call-" + call.conferenceName.slice(-8),
    });

    console.log(`[push] Sending for agent=${call.agentNumber} conf=${call.conferenceName}`);

    let sent = 0;
    const results = await Promise.allSettled(
      subs.map(async (sub, idx) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            payload
          );
          sent++;
          return { idx, ok: true };
        } catch (err: unknown) {
          const code =
            err && typeof err === "object" && "statusCode" in err
              ? (err as { statusCode: number }).statusCode
              : 0;
          const msg =
            err instanceof Error ? err.message : String(err);
          if (code === 410 || code === 404) {
            console.log(`[push] Sub #${idx} expired (${code}), removing`);
            await removePushSubscription(sub.endpoint).catch(() => {});
          } else {
            console.error(`[push] Sub #${idx} failed: code=${code} ${msg}`);
          }
          return { idx, ok: false, code, msg };
        }
      })
    );

    const failures = results.filter(
      (r) => r.status === "fulfilled" && !(r.value as { ok: boolean }).ok
    );
    console.log(
      `[push] Result for ${call.agentNumber}: ${sent}/${subs.length} sent` +
        (failures.length > 0 ? `, ${failures.length} failed` : "")
    );
    await recordPushNotified(call.agentNumber, call.conferenceName);
  }
}

export async function GET(req: NextRequest) {
  try {
    await ensureSheetsReady();

    const status = (req.nextUrl.searchParams.get("status") || "LIVE") as
      | "LIVE"
      | "ENDED"
      | "all";

    const calls = await withRetry(() => getLiveCalls({ status }));

    if (status === "LIVE" || status === "all") {
      const liveCalls = calls.filter((c) => c.status === "LIVE");
      await sendPushForNewCalls(liveCalls);
    }

    return NextResponse.json(
      { ok: true, calls },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GET /api/live-calls] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
