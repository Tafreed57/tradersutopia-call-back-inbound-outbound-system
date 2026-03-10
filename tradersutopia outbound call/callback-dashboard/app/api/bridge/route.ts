/**
 * POST & GET /api/bridge?lead=<E.164>&leadId=<id>&affiliatePhone=<E.164>
 * Twilio webhook — returns TwiML.
 * Whispers to affiliate, then dials the lead with Twilio caller ID.
 */

import { NextRequest, NextResponse } from "next/server";
import { buildBridgeTwiml, buildErrorTwiml, isE164 } from "@/lib/twilio";

export const runtime = "nodejs";

function handleBridge(req: NextRequest) {
  const leadPhone = req.nextUrl.searchParams.get("lead") || "";
  const fullUrl = req.nextUrl.toString();

  console.log(`[bridge] lead=${leadPhone}, url=${fullUrl}`);

  if (!leadPhone || !isE164(leadPhone)) {
    console.warn("[bridge] Invalid or missing lead phone");
    const xml = buildErrorTwiml("Sorry, something went wrong. The lead number is missing.");
    return new NextResponse(xml, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }

  const xml = buildBridgeTwiml(leadPhone);
  return new NextResponse(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

// Twilio sends POST by default, but allow GET too
export async function POST(req: NextRequest) {
  return handleBridge(req);
}

export async function GET(req: NextRequest) {
  return handleBridge(req);
}
