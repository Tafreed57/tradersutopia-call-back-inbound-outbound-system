import type { CallRecording } from "./twilio";
import { databaseRequest } from "./database";

export interface Lead {
  id: string;
  createdAt: string;
  name: string;
  phone: string;
  reason: string;
  status: string;
  calledAt: string;
  calledBy: string;
  notes: string;
  lastUpdatedAt: string;
  calledNumber: string;
}

export interface RecordingFavorite {
  recording: CallRecording;
  favoritedAt: string;
}

export interface LiveCall {
  agentNumber: string;
  conferenceName: string;
  callerNumber: string;
  startTime: string;
  status: string;
  callDuration: string;
  endTime: string;
}

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

let readiness: Promise<void> | null = null;

export async function ensureDataReady(): Promise<void> {
  if (!readiness) {
    readiness = databaseRequest("health")
      .then(() => undefined)
      .catch((error) => {
        readiness = null;
        throw error;
      });
  }
  return readiness;
}

export async function getLeads(opts?: {
  status?: string;
  q?: string;
  sort?: string;
  order?: string;
}): Promise<Lead[]> {
  return databaseRequest<Lead[]>("leads.list", opts || {});
}

export async function getLeadById(id: string): Promise<Lead | null> {
  return databaseRequest<Lead | null>("leads.get", { id });
}

export async function updateLead(
  id: string,
  patch: Partial<Pick<Lead, "status" | "notes" | "calledAt" | "calledBy">>
): Promise<Lead | null> {
  return databaseRequest<Lead | null>("leads.update", { id, patch });
}

export async function upsertMissedCall(input: {
  phone: string;
  calledNumber?: string;
  callSid?: string;
  createdAt?: string;
  digits?: string;
  name?: string;
  reason?: string;
  notes?: string;
}): Promise<Lead> {
  return databaseRequest<Lead>("leads.upsert_missed", input);
}

export async function getRecordingFavorites(): Promise<RecordingFavorite[]> {
  return databaseRequest<RecordingFavorite[]>("favorites.list");
}

export async function saveRecordingFavorite(
  recording: CallRecording
): Promise<RecordingFavorite> {
  return databaseRequest<RecordingFavorite>("favorites.save", { recording });
}

export async function removeRecordingFavorite(recordingSid: string): Promise<void> {
  await databaseRequest("favorites.remove", { recordingSid });
}

export async function getLiveCalls(opts?: {
  status?: "LIVE" | "ENDED" | "all";
}): Promise<LiveCall[]> {
  return databaseRequest<LiveCall[]>("live_calls.list", opts || {});
}

export async function savePushSubscription(sub: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<void> {
  await databaseRequest("push_subscriptions.save", { subscription: sub });
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  await databaseRequest("push_subscriptions.remove", { endpoint });
}

export async function getAllPushSubscriptions(): Promise<PushSub[]> {
  return databaseRequest<PushSub[]>("push_subscriptions.list");
}

export async function getAlreadyNotifiedRecent(): Promise<Set<string>> {
  const keys = await databaseRequest<string[]>("push_notified.recent");
  return new Set(keys);
}

export async function recordPushNotified(
  agentNumber: string,
  conferenceName: string
): Promise<void> {
  await databaseRequest("push_notified.record", { agentNumber, conferenceName });
}

export async function appendLog(entry: {
  logId: string;
  action: string;
  leadId: string;
  affiliatePhone: string;
  details: string;
  twilioCallSid?: string;
  timestamp?: string;
}): Promise<void> {
  await databaseRequest("logs.append", { entry });
}
