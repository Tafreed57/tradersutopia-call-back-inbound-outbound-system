import { NextResponse } from "next/server";
import {
  getLiveCalls,
  getAllPushSubscriptions,
  getAlreadyNotifiedRecent,
} from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const vapidPub =
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
      process.env.VAPID_PUBLIC_KEY ||
      "";
    const vapidPriv = process.env.VAPID_PRIVATE_KEY || "";
    const vapidEmail = process.env.VAPID_EMAIL || "";

    const [liveCalls, subs, notified] = await Promise.all([
      getLiveCalls({ status: "LIVE" }).catch((e: Error) => ({ error: e.message })),
      getAllPushSubscriptions().catch((e: Error) => ({ error: e.message })),
      getAlreadyNotifiedRecent().catch((e: Error) => ({ error: e.message })),
    ]);

    const liveArr = Array.isArray(liveCalls) ? liveCalls : [];
    const subsArr = Array.isArray(subs) ? subs : [];
    const notifiedSet = notified instanceof Set ? notified : new Set();

    return NextResponse.json({
      ok: true,
      vapid: {
        publicKeySet: !!vapidPub,
        publicKeyLength: vapidPub.length,
        privateKeySet: !!vapidPriv,
        emailSet: !!vapidEmail,
      },
      liveCalls: {
        count: liveArr.length,
        calls: liveArr.map((c) => ({
          agent: (c as { agentNumber: string }).agentNumber,
          conf: (c as { conferenceName: string }).conferenceName,
          status: (c as { status: string }).status,
        })),
        error: !Array.isArray(liveCalls) ? (liveCalls as { error: string }).error : undefined,
      },
      subscriptions: {
        count: subsArr.length,
        endpoints: subsArr.map((s) => {
          const ep = (s as { endpoint: string }).endpoint;
          return ep.length > 60 ? ep.slice(0, 30) + "..." + ep.slice(-20) : ep;
        }),
        error: !Array.isArray(subs) ? (subs as { error: string }).error : undefined,
      },
      recentlyNotified: {
        count: notifiedSet.size,
        keys: [...notifiedSet],
        error: !(notified instanceof Set) ? (notified as { error: string }).error : undefined,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
