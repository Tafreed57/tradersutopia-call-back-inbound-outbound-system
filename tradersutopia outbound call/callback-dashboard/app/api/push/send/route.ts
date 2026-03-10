import { NextRequest, NextResponse } from "next/server";
import { getAllPushSubscriptions, removePushSubscription } from "@/lib/sheets";
import webpush from "web-push";

export const runtime = "nodejs";

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:admin@tradersutopia.com";
const PUSH_SECRET = process.env.PUSH_SEND_SECRET || "";

export async function POST(req: NextRequest) {
  try {
    // Verify shared secret so only GAS/Twilio can trigger sends
    const authHeader = req.headers.get("x-push-secret");
    if (!PUSH_SECRET || authHeader !== PUSH_SECRET) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      return NextResponse.json(
        { ok: false, error: "VAPID keys not configured" },
        { status: 500 }
      );
    }

    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

    const body = await req.json();
    const agent = body.agent || "Unknown";
    const callerNumber = body.caller_number || "";
    const ts = body.timestamp ? new Date(body.timestamp) : new Date();
    const timeStr = ts.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Toronto",
    });

    const payload = JSON.stringify({
      title: "Inbound Call Taken",
      body: `Agent ${agent} took a call at ${timeStr} ET` +
        (callerNumber ? ` from ${callerNumber}` : ""),
      url: "/dashboard",
      tag: "tu-call-" + Date.now(),
    });

    const subs = await getAllPushSubscriptions();
    let sent = 0;
    let failed = 0;

    const results = await Promise.allSettled(
      subs.map(async (sub) => {
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
          if (statusCode === 410 || statusCode === 404) {
            await removePushSubscription(sub.endpoint);
          }
          failed++;
        }
      })
    );

    void results; // allSettled always resolves

    return NextResponse.json({ ok: true, sent, failed, total: subs.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/push/send]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
