import { NextRequest, NextResponse } from "next/server";
import { validateAccessCode } from "@/lib/access";
import { loadRecordingAudio, recordingResponse } from "@/lib/recording-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sid: string }> }
) {
  try {
    const auth = validateAccessCode(
      req.nextUrl.searchParams.get("accessCode") || req.headers.get("x-access-code")
    );
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.error },
        { status: auth.status }
      );
    }

    const { sid } = await params;
    const audio = await loadRecordingAudio(sid);
    return recordingResponse(audio, req.headers.get("range"), req.method === "HEAD");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GET /api/recordings/[sid]/media] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const HEAD = GET;
