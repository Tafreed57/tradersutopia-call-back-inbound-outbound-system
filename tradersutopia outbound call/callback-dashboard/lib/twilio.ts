/**
 * lib/twilio.ts
 * Twilio bridge-call helper. Server-side only.
 */

import twilio from "twilio";

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
}): Promise<{ callSid: string }> {
  const client = getClient();
  const twilioNumber = getTwilioNumber();

  const bridgeUrl = `${opts.publicBaseUrl}/api/bridge?lead=${encodeURIComponent(
    opts.leadPhone
  )}&leadId=${encodeURIComponent(opts.leadId || "manual")}&affiliatePhone=${encodeURIComponent(
    opts.affiliatePhone
  )}`;

  const call = await client.calls.create({
    to: opts.affiliatePhone,
    from: twilioNumber,
    url: bridgeUrl,
    method: "POST",
  });

  return { callSid: call.sid };
}

/**
 * Generate TwiML for the bridge endpoint.
 */
export function buildBridgeTwiml(leadPhone: string): string {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  const twilioNumber = getTwilioNumber();

  twiml.say({ voice: "alice", language: "en-US" }, "Connecting you to your callback.");
  const dial = twiml.dial({ callerId: twilioNumber });
  dial.number(leadPhone);

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
