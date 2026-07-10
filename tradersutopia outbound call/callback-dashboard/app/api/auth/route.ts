import { NextRequest, NextResponse } from "next/server";
import { validateAccessCode } from "@/lib/access";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let accessCode = "";

  try {
    const body = await req.json();
    accessCode = body?.accessCode || "";
  } catch {
    accessCode = "";
  }

  const auth = validateAccessCode(accessCode);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status }
    );
  }

  return NextResponse.json({ ok: true });
}
