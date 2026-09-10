import assert from "node:assert/strict";
import test from "node:test";
import { recordingResponse, loadRecordingAudio } from "../lib/recording-media.ts";

const bytes = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => i % 251);
const file = { bytes, contentType: "audio/mpeg" };

test("finite full recording and HEAD metadata agree", async () => {
  const response = recordingResponse(file, null);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(bytes.length));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const head = recordingResponse(file, "bytes=0-", true);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});
test("prefix and late seek return exact bytes and total length", async () => {
  for (const [start,end] of [[0,1023], [bytes.length-4096,bytes.length-1]]) {
    const response = recordingResponse(file, `bytes=${start}-${end}`);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(start,end+1));
}
});
test("suffix ranges are finite", async () => {
  const response = recordingResponse(file, "bytes=-4096");
  assert.equal(response.status,206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(-4096));
});
test("open ranges can reconstruct the entire recording", async () => {
  let position=0;
  while(position<bytes.length) {
    const response=recordingResponse(file,`bytes=${position}-`);
    const chunk=new Uint8Array(await response.arrayBuffer());
    assert(chunk.length>0 && chunk.length<=1024*1024);
    assert.deepEqual(chunk,bytes.slice(position,position+chunk.length));
    position+=chunk.length;
  }
  assert.equal(position,bytes.length);
});
test("invalid ranges return 416, not a misleading full stream", () => {
  for(const range of ["bytes=-0","bytes=-","bytes=8-3","bytes=99999999-","bytes=0-1,3-4","bytes=NaN-"]) {
    const response=recordingResponse(file,range);
    assert.equal(response.status,416,range);
    assert.equal(response.headers.get("content-range"),`bytes */${bytes.length}`);
  }
});
test("upstream streaming is completed and concurrent downloads are coalesced", async () => {
  const originalFetch=global.fetch;
  const oldSid=process.env.TWILIO_SID, oldAuth=process.env.TWILIO_AUTH;
  process.env.TWILIO_SID="AC"+ "0".repeat(32);
  process.env.TWILIO_AUTH="test";
  let fetches=0;
  global.fetch=async () => { fetches++; return new Response(bytes); };
  try {
    const [a,b]=await Promise.all([loadRecordingAudio("RE"+"0".repeat(32)),loadRecordingAudio("RE"+"0".repeat(32))]);
    assert.equal(fetches,1);
    assert.deepEqual(a.bytes,bytes);
    assert.equal(a,b);
  } finally {
    global.fetch=originalFetch;
    if(oldSid===undefined) delete process.env.TWILIO_SID; else process.env.TWILIO_SID=oldSid;
    if(oldAuth===undefined) delete process.env.TWILIO_AUTH; else process.env.TWILIO_AUTH=oldAuth;
  }
});
