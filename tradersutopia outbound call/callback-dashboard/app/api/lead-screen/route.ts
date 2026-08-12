import { NextRequest, NextResponse } from "next/server";
import { buildLeadScreenTwiml } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const answeredBy = String(form?.get("AnsweredBy") || "unknown").toLowerCase();
  const callSid = String(form?.get("CallSid") || "");
  const parentCallSid = String(form?.get("ParentCallSid") || "");

  console.log(
    "[lead-screen]",
    JSON.stringify({ answeredBy, allowed: true, callSid, parentCallSid })
  );

  // Older calls may still reach this endpoint during a deployment. An empty
  // response lets Twilio connect the parties instead of rejecting the answer.
  return new NextResponse(buildLeadScreenTwiml(), {
    status: 200,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
