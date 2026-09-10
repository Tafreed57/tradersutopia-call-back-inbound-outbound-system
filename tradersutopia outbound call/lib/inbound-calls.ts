import twilio from "twilio";
import { databaseRequest } from "./database";

const TERMINAL = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

export async function observeInboundCall(callSid: string, answeredAt?: string) {
  if (!/^CA[0-9a-fA-F]{32}$/.test(callSid)) throw new Error("Invalid inbound call SID");
  const account = process.env.TWILIO_SID;
  const token = process.env.TWILIO_AUTH;
  if (!account || !token) throw new Error("Twilio is not configured");
  const call = await twilio(account, token).calls(callSid).fetch();
  if (call.direction !== "inbound") return { ignored: "not_inbound" };
  // Anonymous/blocked callers cannot be dialed back.
  if (!/^\+[1-9]\d{6,14}$/.test(call.from)) return { ignored: "unavailable_caller_number" };
  await databaseRequest("inbound.record", {
    callSid: call.sid,
    phone: call.from,
    calledNumber: call.to,
    startedAt: (call.startTime || call.dateCreated).toISOString(),
    endedAt: TERMINAL.has(call.status) ? (call.endTime || call.dateUpdated).toISOString() : null,
    answeredAt: answeredAt || null,
  });
  return { recorded: true };
}
