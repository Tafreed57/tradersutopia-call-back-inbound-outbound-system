import { Readable } from "node:stream";

const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const RANGE_CHUNK_BYTES = 1024 * 1024;
type AudioFile = { bytes: Uint8Array; contentType: string };
const cache = new Map<string, { file: AudioFile; expires: number }>();
const pending = new Map<string, Promise<AudioFile>>();

export async function loadRecordingAudio(recordingSid: string): Promise<AudioFile> {
  if (!/^RE[0-9a-fA-F]{32}$/.test(recordingSid)) throw new Error("Invalid recording SID");
  const account = process.env.TWILIO_SID;
  const token = process.env.TWILIO_AUTH;
  if (!account || !token) throw new Error("Missing TWILIO_SID or TWILIO_AUTH");
  const key = account + "/" + recordingSid;
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.file;
  cache.delete(key);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const download = (async () => {
    // Twilio's MP3 endpoint ignores Range and streams without Content-Length.
    // Finish the download before exposing a finite, seekable file to the browser.
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}/Recordings/${recordingSid}.mp3`,
      {
        headers: { Authorization: `Basic ${Buffer.from(`${account}:${token}`).toString("base64")}` },
        cache: "no-store",
        signal: AbortSignal.timeout(90_000),
      }
    );
    if (!response.ok || !response.body) {
      throw new Error(`Twilio recording fetch failed (${response.status})`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_AUDIO_BYTES) throw new Error("Recording exceeds the playback size limit");
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    if (!size) throw new Error("Recording audio is empty");
    const file = { bytes: new Uint8Array(Buffer.concat(chunks, size)), contentType: "audio/mpeg" };
    let used = 0;
    for (const [entryKey, entry] of cache) {
      if (entry.expires <= Date.now()) cache.delete(entryKey);
      else used += entry.file.bytes.byteLength;
    }
    for (const [entryKey, entry] of cache) {
      if (used + size <= CACHE_BYTES) break;
      cache.delete(entryKey);
      used -= entry.file.bytes.byteLength;
    }
    if (size <= CACHE_BYTES) cache.set(key, { file, expires: Date.now() + CACHE_TTL_MS });
    return file;
  })();
  pending.set(key, download);
  try { return await download; } finally { pending.delete(key); }
}
export function recordingResponse(file: AudioFile, range: string | null, head = false): Response {
  const size = file.bytes.byteLength;
  const headers = new Headers({
    "Content-Type": file.contentType,
    "Cache-Control": "private, no-store, no-transform",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  });
  let start = 0;
  let end = size - 1;
  if (range && !head) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const invalid = () => {
      headers.set("Content-Range", `bytes */${size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    };
    if (!match || (!match[1] && !match[2])) return invalid();
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
      start = Math.max(0, size - suffix);
    } else {
      start = Number(match[1]);
      const requestedEnd = match[2] ? Number(match[2]) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
          start >= size || requestedEnd < start) return invalid();
      end = Math.min(requestedEnd, size - 1);
      // Bound each browser fetch; subsequent seeks receive the exact next range.
      end = Math.min(end, start + RANGE_CHUNK_BYTES - 1);
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  const bytes = file.bytes;
  async function* chunks() {
    for (let offset = start; offset <= end; offset += 64 * 1024) {
      yield bytes.subarray(offset, Math.min(offset + 64 * 1024, end + 1));
    }
  }
  const body = head ? null : Readable.toWeb(Readable.from(chunks())) as ReadableStream<Uint8Array>;
  return new Response(body, { status: range && !head ? 206 : 200, headers });
}
