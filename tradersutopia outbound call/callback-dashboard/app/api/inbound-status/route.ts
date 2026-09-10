import twilio from "twilio";
import { NextRequest, NextResponse } from "next/server";
import { observeInboundCall } from "@/lib/inbound-calls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Studio still needs the terminal event to close its execution.
const STUDIO_FLOW = "FW0e50c6f78cbeb6ac755a8db47dfe7015";

export async function POST(req: NextRequest) {
  const token = process.env.TWILIO_AUTH || "";
  const account = process.env.TWILIO_SID || "";
  const params = Object.fromEntries(new URLSearchParams(await req.text()));
  const signature = req.headers.get("x-twilio-signature") || "";
  const publicUrl = new URL(req.nextUrl.pathname + req.nextUrl.search,
    process.env.APP_BASE_URL || "https://tradersutopia-callback-dashboard.vercel.app").toString();
  if (!token || params.AccountSid !== account ||
      !twilio.validateRequest(token, signature, publicUrl, params)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }

  try {
    const studioUrl = `https://webhooks.twilio.com/v1/Accounts/${account}/Flows/${process.env.TWILIO_STUDIO_FLOW_SID || STUDIO_FLOW}`;
    // Finish both operations even if one fails. Twilio retries are idempotent.
    const results = await Promise.allSettled([
      observeInboundCall(params.CallSid || ""),
      fetch(studioUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": twilio.getExpectedTwilioSignature(token, studioUrl, params),
        },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(8_000),
      }).then(async (response) => {
        await response.text();
        if (!response.ok) throw new Error(`Studio status forwarding failed (${response.status})`);
      }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[inbound-status]", params.CallSid, error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: "Inbound status processing failed" }, { status: 500 });
  }
}
