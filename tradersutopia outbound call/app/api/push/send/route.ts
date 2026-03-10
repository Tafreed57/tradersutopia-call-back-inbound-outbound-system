import { NextRequest, NextResponse } from "next/server";
import { getAllPushSubscriptions, removePushSubscription } from "@/lib/sheets";
import webpush from "web-push";

export const runtime = "nodejs";

const VAPID_PUBLIC =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
  process.env.VAPID_PUBLIC_KEY ||
  "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:admin@tradersutopia.com";
const PUSH_SECRET = process.env.PUSH_SEND_SECRET || "";

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("x-push-secret");
    console.log(
      `[push/send] Received request. Auth=${authHeader ? "present" : "missing"}, ` +
      `SecretConfigured=${!!PUSH_SECRET}, Match=${authHeader === PUSH_SECRET}`
    );

    if (!PUSH_SECRET || authHeader !== PUSH_SECRET) {
      console.log("[push/send] REJECTED: secret mismatch");
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      console.log("[push/send] ABORT: VAPID keys missing");
      return NextResponse.json(
        { ok: false, error: "VAPID keys not configured" },
        { status: 500 }
      );
    }

    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

    const body = await req.json();
    const agent = body.agent || "Unknown";
    const callerNumber = body.caller_number || "";
    const conferenceName = body.conference_name || "";
    const ts = body.timestamp ? new Date(body.timestamp) : new Date();
    const timeStr = ts.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Toronto",
    });

    console.log(`[push/send] Agent=${agent} Conf=${conferenceName} Caller=${callerNumber}`);

    const payload = JSON.stringify({
      title: "Inbound Call Taken",
      body: `Agent ${agent} took a call at ${timeStr} ET`,
      url: "/dashboard",
      tag: "tu-call-" + (conferenceName ? conferenceName.slice(-8) : Date.now()),
    });

    const subs = await getAllPushSubscriptions();
    console.log(`[push/send] ${subs.length} subscriber(s)`);

    if (subs.length === 0) {
      return NextResponse.json({ ok: true, sent: 0, failed: 0, total: 0 });
    }

    let sent = 0;
    let failed = 0;

    await Promise.allSettled(
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
        } catch (err: unknown) {
          const statusCode =
            err && typeof err === "object" && "statusCode" in err
              ? (err as { statusCode: number }).statusCode
              : 0;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[push/send] Sub #${idx} failed: code=${statusCode} ${msg}`);
          if (statusCode === 410 || statusCode === 404) {
            await removePushSubscription(sub.endpoint).catch(() => {});
          }
          failed++;
        }
      })
    );

    console.log(`[push/send] Done: ${sent}/${subs.length} sent, ${failed} failed`);
    return NextResponse.json({ ok: true, sent, failed, total: subs.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[push/send] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
