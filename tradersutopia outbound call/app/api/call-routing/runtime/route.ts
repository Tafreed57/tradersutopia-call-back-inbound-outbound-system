import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getCallRoutingConfig } from "@/lib/call-routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretMatches(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(req: NextRequest) {
  const expectedSecret = process.env.CALL_ROUTING_SECRET || "";
  const receivedSecret = req.headers.get("x-call-routing-secret") || "";
  if (!expectedSecret || !secretMatches(receivedSecret, expectedSecret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const calledNumber = req.nextUrl.searchParams.get("calledNumber") || "";
    const config = await getCallRoutingConfig();
    const exactLine = config.lines.find((line) => line.phone === calledNumber);
    const fallbackLine =
      config.lines.find((line) => line.enabled && line.isDefault) ||
      config.lines.find((line) => line.enabled);
    const selectedLine = exactLine || fallbackLine;
    const lineEnabled = selectedLine?.enabled ?? false;

    return NextResponse.json(
      {
        ok: true,
        agents: lineEnabled && selectedLine
          ? config.agents
              .filter(
                (agent) =>
                  agent.enabled &&
                  (agent.linePhones.length === 0 || agent.linePhones.includes(selectedLine.phone))
              )
              .map((agent) => agent.phone)
          : [],
        fromNumber: selectedLine?.phone || "",
        line: selectedLine
          ? { phone: selectedLine.phone, label: selectedLine.label, enabled: selectedLine.enabled }
          : null,
      },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load runtime routing";
    console.error("[GET /api/call-routing/runtime]", message);
    return NextResponse.json({ ok: false, error: "Routing data unavailable" }, { status: 503 });
  }
}
