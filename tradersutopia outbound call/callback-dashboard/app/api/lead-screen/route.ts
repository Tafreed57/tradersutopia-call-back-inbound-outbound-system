import { NextRequest, NextResponse } from "next/server";
import { buildLeadScreenTwiml } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const answeredBy = String(form?.get("AnsweredBy") || "unknown").toLowerCase();
  const callSid = String(form?.get("CallSid") || "");
  const parentCallSid = String(form?.get("ParentCallSid") || "");
  const allowed = answeredBy === "human";

  console.log(
    "[lead-screen]",
    JSON.stringify({ answeredBy, allowed, callSid, parentCallSid })
  );

  return new NextResponse(buildLeadScreenTwiml(answeredBy), {
    status: 200,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
