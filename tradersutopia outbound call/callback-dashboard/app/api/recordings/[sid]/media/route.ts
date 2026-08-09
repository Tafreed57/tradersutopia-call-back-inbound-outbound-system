import { NextRequest, NextResponse } from "next/server";
import { validateAccessCode } from "@/lib/access";
import { fetchRecordingAudio } from "@/lib/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const audio = await fetchRecordingAudio(sid, req.headers.get("range"));
    const headers = new Headers({
      "Content-Type": audio.contentType,
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
    });
    if (audio.contentLength) headers.set("Content-Length", audio.contentLength);
    if (audio.contentRange) headers.set("Content-Range", audio.contentRange);

    return new NextResponse(audio.body, { status: audio.status, headers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GET /api/recordings/[sid]/media] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
