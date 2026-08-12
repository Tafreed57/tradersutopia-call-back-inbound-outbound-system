/**
 * lib/twilio.ts
 * Twilio bridge-call helper. Server-side only.
 */

import twilio from "twilio";

const OUTBOUND_STATUS_EVENTS: Array<"initiated" | "ringing" | "answered" | "completed"> = [
  "initiated",
  "ringing",
  "answered",
  "completed",
];

export interface CallRecording {
  sid: string;
  callSid: string;
  conferenceSid: string;
  conferenceName: string;
  status: string;
  dateCreated: string;
  duration: string;
  channels: number;
  source: string;
  from: string;
  to: string;
  direction: string;
  callStatus: string;
  startTime: string;
  endTime: string;
  customerPhone: string;
  agentPhone: string;
  answeredBy: string;
  connectedDuration: number;
  verification: "conference-bridge" | "human-detected" | "connected-duration";
}

type RecordingResource = {
  sid: string;
  callSid?: string | null;
  conferenceSid?: string | null;
  status?: string | null;
  dateCreated?: Date | string | null;
  duration?: string | null;
  channels?: number | null;
  source?: string | null;
};

type CallResource = {
  sid?: string | null;
  parentCallSid?: string | null;
  from?: string | null;
  to?: string | null;
  direction?: string | null;
  status?: string | null;
  duration?: string | null;
  answeredBy?: string | null;
  startTime?: Date | string | null;
  endTime?: Date | string | null;
};

type ConferenceResource = {
  friendlyName?: string | null;
  status?: string | null;
};

const DEFAULT_RECORDING_WINDOW_DAYS = 7;
const MIN_CONFERENCE_RECORDING_SECONDS = 1;
const MIN_CONNECTED_RECORDING_SECONDS = 10;
const LEGACY_CONNECTED_RECORDING_SECONDS = 60;

function getClient() {
  const sid = process.env.TWILIO_SID;
  const auth = process.env.TWILIO_AUTH;
  if (!sid || !auth) throw new Error("Missing TWILIO_SID or TWILIO_AUTH");
  return twilio(sid, auth);
}

function getTwilioNumber(): string {
  const num = process.env.TWILIO_NUMBER;
  if (!num) throw new Error("Missing TWILIO_NUMBER");
  return num;
}

function statusCallbackUrl(
  publicBaseUrl: string,
  params: Record<string, string>
): string {
  const url = new URL(`${publicBaseUrl.replace(/\/+$/, "")}/api/twilio-status`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function recordingStatusCallbackUrl(
  publicBaseUrl: string,
  params: Record<string, string>
): string {
  const url = new URL(`${publicBaseUrl.replace(/\/+$/, "")}/api/recording-status`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Initiate a two-leg bridge call.
 * 1) Twilio calls the affiliate.
 * 2) When affiliate answers, Twilio POSTs to bridgeUrl which returns TwiML
 *    that whispers + dials the lead.
 */
export async function startBridgeCall(opts: {
  affiliatePhone: string;
  leadPhone: string;
  leadId: string;
  publicBaseUrl: string;
  fromNumber: string;
}): Promise<{ callSid: string }> {
  const client = getClient();
  const twilioNumber = opts.fromNumber || getTwilioNumber();

  const bridgeUrl = `${opts.publicBaseUrl}/api/bridge?lead=${encodeURIComponent(
    opts.leadPhone
  )}&leadId=${encodeURIComponent(opts.leadId || "manual")}&affiliatePhone=${encodeURIComponent(
    opts.affiliatePhone
  )}&fromNumber=${encodeURIComponent(twilioNumber)}`;
  const affiliateStatusUrl = statusCallbackUrl(opts.publicBaseUrl, {
    leg: "affiliate",
    leadId: opts.leadId || "manual",
    affiliatePhone: opts.affiliatePhone,
    lead: opts.leadPhone,
    fromNumber: twilioNumber,
  });

  const call = await client.calls.create({
    to: opts.affiliatePhone,
    from: twilioNumber,
    url: bridgeUrl,
    method: "POST",
    statusCallback: affiliateStatusUrl,
    statusCallbackEvent: OUTBOUND_STATUS_EVENTS,
    statusCallbackMethod: "POST",
  });

  return { callSid: call.sid };
}

/**
 * Generate TwiML for the bridge endpoint.
 */
export function buildBridgeTwiml(
  leadPhone: string,
  opts?: {
    publicBaseUrl?: string;
    leadId?: string;
    affiliatePhone?: string;
    fromNumber?: string;
  }
): string {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  const twilioNumber = opts?.fromNumber || getTwilioNumber();

  twiml.say({ voice: "alice", language: "en-US" }, "Connecting you to your callback.");

  const dialOptions: {
    callerId: string;
    answerOnBridge: boolean;
    record: "record-from-answer-dual";
    recordingStatusCallback?: string;
    recordingStatusCallbackEvent?: Array<"completed">;
    recordingStatusCallbackMethod?: "POST";
  } = {
    callerId: twilioNumber,
    answerOnBridge: true,
    record: "record-from-answer-dual",
  };

  if (opts?.publicBaseUrl) {
    const leadStatusUrl = statusCallbackUrl(opts.publicBaseUrl, {
      leg: "lead",
      leadId: opts.leadId || "manual",
      affiliatePhone: opts.affiliatePhone || "",
      lead: leadPhone,
      fromNumber: twilioNumber,
    });
    dialOptions.recordingStatusCallback = recordingStatusCallbackUrl(opts.publicBaseUrl, {
      source: "outbound_bridge",
      leadId: opts.leadId || "manual",
      affiliatePhone: opts.affiliatePhone || "",
      lead: leadPhone,
      fromNumber: twilioNumber,
    });
    dialOptions.recordingStatusCallbackEvent = ["completed"];
    dialOptions.recordingStatusCallbackMethod = "POST";

    const dial = twiml.dial(dialOptions);

    dial.number(
      {
        statusCallback: leadStatusUrl,
        statusCallbackEvent: OUTBOUND_STATUS_EVENTS,
        statusCallbackMethod: "POST",
      },
      leadPhone
    );
  } else {
    const dial = twiml.dial(dialOptions);
    dial.number(leadPhone);
  }

  return twiml.toString();
}

export function buildLeadScreenTwiml(): string {
  const twiml = new twilio.twiml.VoiceResponse();
  return twiml.toString();
}

/**
 * Generate error TwiML.
 */
export function buildErrorTwiml(message: string): string {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  twiml.say(message);
  twiml.hangup();
  return twiml.toString();
}

export function isE164(val: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(val);
}

export async function listCallRecordings(
  limit = 50,
  days = DEFAULT_RECORDING_WINDOW_DAYS
): Promise<CallRecording[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const safeDays = Math.max(1, Math.min(days, 31));
  const dateCreatedAfter = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const client = getClient();
  const candidateLimit = Math.min(200, Math.max(50, safeLimit * 4));
  const recordings = (
    await client.recordings.list({ dateCreatedAfter, limit: candidateLimit })
  ) as RecordingResource[];

  const completedRecordings = recordings.filter(
    (recording) =>
      recording.status === "completed" &&
      parseDuration(recording.duration) >= MIN_CONFERENCE_RECORDING_SECONDS
  );

  const callSids = Array.from(
    new Set(completedRecordings.map((recording) => recording.callSid).filter(Boolean) as string[])
  );
  const conferenceSids = Array.from(
    new Set(completedRecordings.map((recording) => recording.conferenceSid).filter(Boolean) as string[])
  );

  const conferenceMap = new Map<string, ConferenceResource>();
  await Promise.all(
    conferenceSids.map(async (conferenceSid) => {
      try {
        const conference = (await client.conferences(conferenceSid).fetch()) as ConferenceResource;
        conferenceMap.set(conferenceSid, conference);
      } catch (err) {
        console.warn(
          "[recordings] conference lookup skipped",
          conferenceSid,
          err instanceof Error ? err.message : err
        );
      }
    })
  );

  const conferenceCallSids = Array.from(
    new Set(
      [...conferenceMap.values()]
        .map((conference) => extractCallerCallSid(conference.friendlyName || ""))
        .filter(Boolean) as string[]
    )
  );

  const callMap = new Map<string, CallResource>();
  await Promise.all(
    [...new Set([...callSids, ...conferenceCallSids])].map(async (callSid) => {
      try {
        const call = (await client.calls(callSid).fetch()) as CallResource;
        callMap.set(callSid, call);
      } catch (err) {
        console.warn("[recordings] call lookup skipped", callSid, err instanceof Error ? err.message : err);
      }
    })
  );

  const childCallMap = new Map<string, CallResource[]>();
  await Promise.all(
    callSids.map(async (callSid) => {
      try {
        const childCalls = (await client.calls.list({ parentCallSid: callSid, limit: 20 })) as CallResource[];
        childCallMap.set(callSid, childCalls);
      } catch (err) {
        console.warn(
          "[recordings] child call lookup skipped",
          callSid,
          err instanceof Error ? err.message : err
        );
      }
    })
  );

  return completedRecordings.flatMap((recording): CallRecording[] => {
    const callSid = recording.callSid || "";
    const conferenceSid = recording.conferenceSid || "";
    const conference = conferenceSid ? conferenceMap.get(conferenceSid) : undefined;
    const conferenceCallSid = extractCallerCallSid(conference?.friendlyName || "");
    const call = callMap.get(conferenceCallSid || callSid);
    const childCall = selectConnectedChildCall(childCallMap.get(callSid) || []);
    const connectedDuration = parseDuration(recording.duration);
    const answeredBy = (childCall?.answeredBy || "").toLowerCase();
    const isConferenceRecording =
      Boolean(conferenceSid) &&
      conference?.status === "completed" &&
      connectedDuration >= MIN_CONFERENCE_RECORDING_SECONDS;
    const isHumanDetected = answeredBy === "human";
    const isLegacyConnected =
      !answeredBy &&
      recording.channels === 2 &&
      connectedDuration >= LEGACY_CONNECTED_RECORDING_SECONDS;
    const isConnectedDial =
      !conferenceSid &&
      connectedDuration >= MIN_CONNECTED_RECORDING_SECONDS &&
      call?.status === "completed" &&
      childCall?.status === "completed" &&
      parseDuration(childCall.duration) >= MIN_CONNECTED_RECORDING_SECONDS &&
      (isHumanDetected || isLegacyConnected);

    if (!isConferenceRecording && !isConnectedDial) return [];

    const customerPhone = isConferenceRecording ? call?.from || "" : childCall?.to || "";
    const agentPhone = isConferenceRecording ? "" : call?.to || "";
    const verification: CallRecording["verification"] = isConferenceRecording
      ? "conference-bridge"
      : isHumanDetected
        ? "human-detected"
        : "connected-duration";

    return [{
      sid: recording.sid,
      callSid,
      conferenceSid,
      conferenceName: conference?.friendlyName || "",
      status: recording.status || "",
      dateCreated: toIso(recording.dateCreated),
      duration: recording.duration || "",
      channels: recording.channels || 0,
      source: recording.source || (conferenceSid ? "Conference" : "Call"),
      from: customerPhone || call?.from || "",
      to: agentPhone || call?.to || "",
      direction: isConferenceRecording ? "inbound" : "outbound",
      callStatus: childCall?.status || call?.status || conference?.status || "",
      startTime: toIso(childCall?.startTime || call?.startTime),
      endTime: toIso(childCall?.endTime || call?.endTime),
      customerPhone,
      agentPhone,
      answeredBy,
      connectedDuration,
      verification,
    }];
  }).slice(0, safeLimit);
}

export async function fetchRecordingAudio(recordingSid: string, range?: string | null): Promise<{
  body: ReadableStream<Uint8Array> | ArrayBuffer;
  contentType: string;
  contentLength: string;
  contentRange: string;
  status: number;
}> {
  if (!/^RE[0-9a-fA-F]{32}$/.test(recordingSid)) {
    throw new Error("Invalid recording SID");
  }

  const sid = process.env.TWILIO_SID;
  const auth = process.env.TWILIO_AUTH;
  if (!sid || !auth) throw new Error("Missing TWILIO_SID or TWILIO_AUTH");

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Recordings/${recordingSid}.mp3`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}`,
        ...(range ? { Range: range } : {}),
      },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    throw new Error(`Twilio recording fetch failed (${res.status})`);
  }

  return {
    body: res.body || (await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "audio/mpeg",
    contentLength: res.headers.get("content-length") || "",
    contentRange: res.headers.get("content-range") || "",
    status: res.status === 206 ? 206 : 200,
  };
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function extractCallerCallSid(conferenceName: string): string {
  return conferenceName.match(/^TU_(CA[0-9a-fA-F]{32})(?:_|$)/)?.[1] || "";
}

function parseDuration(value: string | null | undefined): number {
  const duration = Number(value || 0);
  return Number.isFinite(duration) ? duration : 0;
}

function selectConnectedChildCall(calls: CallResource[]): CallResource | undefined {
  return [...calls]
    .filter((call) => call.direction === "outbound-dial")
    .sort((a, b) => parseDuration(b.duration) - parseDuration(a.duration))[0];
}
