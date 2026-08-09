import { NextRequest, NextResponse } from "next/server";
import { validateAccessCode } from "@/lib/access";
import {
  configureTwilioInboundNumber,
  getCallRoutingConfig,
  removeRoutingAgent,
  upsertRoutingAgent,
  upsertRoutingLine,
} from "@/lib/call-routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FailedAccess = Extract<ReturnType<typeof validateAccessCode>, { ok: false }>;

function unauthorized(auth: FailedAccess) {
  return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
}

export async function GET(req: NextRequest) {
  try {
    const auth = validateAccessCode(
      req.nextUrl.searchParams.get("accessCode") || req.headers.get("x-access-code")
    );
    if (!auth.ok) return unauthorized(auth);

    const config = await getCallRoutingConfig();
    return NextResponse.json(
      { ok: true, ...config },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load call routing";
    console.error("[GET /api/call-routing]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auth = validateAccessCode(body.accessCode);
    if (!auth.ok) return unauthorized(auth);

    const type = String(body.type || "").toLowerCase();
    const action = String(body.action || "upsert").toLowerCase();
    const phone = String(body.phone || "");

    if (type === "agent" && action === "remove") {
      const config = await removeRoutingAgent(phone);
      return NextResponse.json({ ok: true, ...config });
    }

    if (type === "agent") {
      const config = await upsertRoutingAgent({
        phone,
        label: typeof body.label === "string" ? body.label : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      });
      return NextResponse.json({ ok: true, ...config });
    }

    if (type === "line") {
      const current = await getCallRoutingConfig();
      const existing = current.lines.find((line) => line.phone === phone);
      if (
        existing?.enabled &&
        body.enabled === false &&
        current.lines.filter((line) => line.enabled).length === 1
      ) {
        return NextResponse.json(
          { ok: false, error: "At least one Twilio line must remain active" },
          { status: 400 }
        );
      }

      let twilioSid = typeof body.twilioSid === "string" ? body.twilioSid : "";
      if (body.configureTwilio === true) {
        const configured = await configureTwilioInboundNumber(phone);
        twilioSid = configured.sid;
      }
      const config = await upsertRoutingLine({
        phone,
        label: typeof body.label === "string" ? body.label : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        isDefault: typeof body.isDefault === "boolean" ? body.isDefault : undefined,
        twilioSid,
      });
      return NextResponse.json({ ok: true, ...config });
    }

    return NextResponse.json({ ok: false, error: "Routing type must be agent or line" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update call routing";
    console.error("[POST /api/call-routing]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
