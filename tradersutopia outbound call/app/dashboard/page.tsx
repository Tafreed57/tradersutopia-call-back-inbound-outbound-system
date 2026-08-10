"use client";

import { useState, useEffect, useCallback } from "react";
import { formatDateValue } from "@/lib/dates";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Lead {
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

interface RoutingAgent {
  phone: string;
  label: string;
  enabled: boolean;
  updatedAt: string;
  linePhones: string[];
}

interface RoutingLine {
  phone: string;
  label: string;
  enabled: boolean;
  isDefault: boolean;
  twilioSid: string;
  updatedAt: string;
}

interface LiveCall {
  agentNumber: string;
  conferenceName: string;
  callerNumber: string;
  startTime: string;
  status: string;
  callDuration: string;
  endTime: string;
}

interface CallRecording {
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
  isFavorite: boolean;
  favoritedAt: string;
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  // Auth state
  const [accessCode, setAccessCode] = useState("");
  const [isAuth, setIsAuth] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  // Affiliate phone
  const [affiliatePhone, setAffiliatePhone] = useState("");
  const [phoneSet, setPhoneSet] = useState(false);

  // Leads
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");

  // Action feedback
  const [actionMsg, setActionMsg] = useState<{ id: string; msg: string; type: "ok" | "err" } | null>(null);
  // Prevent double-clicks on Mark Called / Mark Pending (track busy lead IDs)
  const [busyLeads, setBusyLeads] = useState<Set<string>>(new Set());
  // Track leads that have been dialed in this session (shows "Dialed" indicator)
  const [dialedLeads, setDialedLeads] = useState<Set<string>>(new Set());

  // Manual dial (keypad)
  const [manualNumber, setManualNumber] = useState("");
  const [manualMsg, setManualMsg] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const [manualDialing, setManualDialing] = useState(false);
  const [manualFromNumber, setManualFromNumber] = useState("");

  // Dashboard-managed call routing
  const [routingAgents, setRoutingAgents] = useState<RoutingAgent[]>([]);
  const [routingLines, setRoutingLines] = useState<RoutingLine[]>([]);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [routingLoading, setRoutingLoading] = useState(false);
  const [routingBusy, setRoutingBusy] = useState("");
  const [routingError, setRoutingError] = useState("");
  const [newAgentPhone, setNewAgentPhone] = useState("");
  const [newAgentLabel, setNewAgentLabel] = useState("");
  const [newAgentLinePhone, setNewAgentLinePhone] = useState("");
  const [newLinePhone, setNewLinePhone] = useState("");
  const [newLineLabel, setNewLineLabel] = useState("");

  // Live calls
  const [liveCalls, setLiveCalls] = useState<LiveCall[]>([]);
  const [liveCallsOpen, setLiveCallsOpen] = useState(true);

  // Recorded calls
  const [recordings, setRecordings] = useState<CallRecording[]>([]);
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [recordingsLoading, setRecordingsLoading] = useState(false);
  const [recordingsError, setRecordingsError] = useState("");
  const [recordingRecentCount, setRecordingRecentCount] = useState(0);
  const [recordingsView, setRecordingsView] = useState<"all" | "favorites">("all");
  const [favoriteBusy, setFavoriteBusy] = useState<Set<string>>(new Set());

  // Push notifications
  const [pushSupported, setPushSupported] = useState(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>("default");
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const getStoredAccessCode = useCallback(() => {
    return localStorage.getItem("cb_code") || accessCode.trim();
  }, [accessCode]);

  const resetAuth = useCallback((message = "Invalid access code. Please log in again.") => {
    localStorage.removeItem("cb_auth");
    localStorage.removeItem("cb_code");
    setIsAuth(false);
    setAuthError(message);
  }, []);

  const validateCode = useCallback(async (code: string) => {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: code }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: res.ok && data.ok,
      error: data.error || "Unable to validate access code.",
    };
  }, []);

  // ── Restore from localStorage ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      const savedAuth = localStorage.getItem("cb_auth");
      const savedCode = localStorage.getItem("cb_code");
      const savedPhone = localStorage.getItem("cb_phone");

      if (savedPhone) {
        const normalizedPhone = normalizePhone(savedPhone);
        if (/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
          localStorage.setItem("cb_phone", normalizedPhone);
          setAffiliatePhone(normalizedPhone);
          setPhoneSet(true);
        }
      }

      if (savedAuth === "true" && savedCode) {
        setAccessCode(savedCode);
        const result = await validateCode(savedCode);
        if (cancelled) return;

        if (result.ok) {
          setIsAuth(true);
          setAuthError("");
        } else {
          resetAuth(result.error);
        }
      }
    }

    restoreSession();
    return () => {
      cancelled = true;
    };
  }, [resetAuth, validateCode]);

  // ── Service Worker + Push Notifications ────────────────────────────────────
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").then(async (reg) => {
      if (!("PushManager" in window)) return;
      setPushSupported(true);
      setPushPermission(Notification.permission);

      const existing = await reg.pushManager.getSubscription();
      setPushSubscribed(!!existing);
    });
  }, []);

  async function handleEnablePush() {
    setPushBusy(true);
    try {
      const permission = await Notification.requestPermission();
      setPushPermission(permission);
      if (permission !== "granted") { setPushBusy(false); return; }

      const reg = await navigator.serviceWorker.ready;
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidKey) { setPushBusy(false); return; }

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
      }

      const subJson = sub.toJSON();
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
        }),
      });
      setPushSubscribed(true);
    } catch (err) {
      console.error("Push subscription error:", err);
    }
    setPushBusy(false);
  }

  async function handleDisablePush() {
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setPushSubscribed(false);
    } catch (err) {
      console.error("Push unsubscribe error:", err);
    }
    setPushBusy(false);
  }

  // ── Login handler ───────────────────────────────────────────────────────────
  async function handleLogin() {
    const code = accessCode.trim();
    if (!code) {
      setAuthError("Enter the access code.");
      return;
    }

    setAuthBusy(true);
    const result = await validateCode(code);
    setAuthBusy(false);

    if (!result.ok) {
      localStorage.removeItem("cb_auth");
      localStorage.removeItem("cb_code");
      setAuthError(result.error);
      return;
    }

    localStorage.setItem("cb_auth", "true");
    localStorage.setItem("cb_code", code);
    setAccessCode(code);
    setIsAuth(true);
    setAuthError("");
  }

  function handleLogout() {
    localStorage.removeItem("cb_auth");
    localStorage.removeItem("cb_code");
    setIsAuth(false);
    setAccessCode("");
  }

  // ── Phone handler ───────────────────────────────────────────────────────────
  function handleSetPhone() {
    const normalizedPhone = normalizePhone(affiliatePhone);
    if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
      alert("Phone must be E.164 format, e.g. +14375053539");
      return;
    }
    localStorage.setItem("cb_phone", normalizedPhone);
    setAffiliatePhone(normalizedPhone);
    setPhoneSet(true);
  }

  function handleChangePhone() {
    setPhoneSet(false);
  }

  // ── Fetch leads ─────────────────────────────────────────────────────────────
  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        q: search,
        sort: "createdAt",
        order: sortOrder,
        accessCode: getStoredAccessCode(),
      });
      const res = await fetch(`/api/leads?${params}&t=${Date.now()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.status === 401) {
        resetAuth(data.error);
        return;
      }
      if (data.ok) setLeads(data.leads);
      else console.error("Fetch leads error:", data.error);
    } catch (err) {
      console.error("Fetch leads error:", err);
    }
    setLoading(false);
  }, [statusFilter, search, sortOrder, getStoredAccessCode, resetAuth]);

  useEffect(() => {
    if (!isAuth || !phoneSet) return;
    const timer = window.setTimeout(() => {
      void fetchLeads();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isAuth, phoneSet, fetchLeads]);

  // Keep callback status current for agents without requiring manual refresh.
  useEffect(() => {
    if (!isAuth || !phoneSet) return;
    const interval = setInterval(fetchLeads, 30000);
    return () => clearInterval(interval);
  }, [isAuth, phoneSet, fetchLeads]);

  // ── Live Calls ─────────────────────────────────────────────────────────────
  const fetchLiveCalls = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        status: "LIVE",
        accessCode: getStoredAccessCode(),
        t: String(Date.now()),
      });
      const res = await fetch(`/api/live-calls?${params}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.status === 401) {
        resetAuth(data.error);
        return;
      }
      if (data.ok) setLiveCalls(data.calls);
    } catch (err) {
      console.error("Fetch live calls error:", err);
    }
  }, [getStoredAccessCode, resetAuth]);

  useEffect(() => {
    if (!isAuth || !phoneSet) return;
    const timer = window.setTimeout(() => {
      void fetchLiveCalls();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isAuth, phoneSet, fetchLiveCalls]);

  useEffect(() => {
    if (!isAuth || !phoneSet) return;
    const interval = setInterval(fetchLiveCalls, 5000);
    return () => clearInterval(interval);
  }, [isAuth, phoneSet, fetchLiveCalls]);

  const fetchRecordings = useCallback(async () => {
    setRecordingsLoading(true);
    setRecordingsError("");
    try {
      const params = new URLSearchParams({
        limit: "50",
        days: "7",
        accessCode: getStoredAccessCode(),
        t: String(Date.now()),
      });
      const res = await fetch(`/api/recordings?${params}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.status === 401) {
        resetAuth(data.error);
        return;
      }
      if (data.ok) {
        setRecordings(Array.isArray(data.recordings) ? data.recordings : []);
        setRecordingRecentCount(Number(data.recentCount || 0));
      } else {
        setRecordingsError(data.error || "Unable to load recordings.");
      }
    } catch (err) {
      console.error("Fetch recordings error:", err);
      setRecordingsError("Unable to load recordings.");
    } finally {
      setRecordingsLoading(false);
    }
  }, [getStoredAccessCode, resetAuth]);

  useEffect(() => {
    if (!isAuth || !phoneSet) return;
    const timer = window.setTimeout(() => {
      void fetchRecordings();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isAuth, phoneSet, fetchRecordings]);

  useEffect(() => {
    if (!isAuth || !phoneSet) return;
    const interval = setInterval(fetchRecordings, 30000);
    return () => clearInterval(interval);
  }, [isAuth, phoneSet, fetchRecordings]);

  const applyRoutingData = useCallback((data: {
    agents?: RoutingAgent[];
    lines?: RoutingLine[];
  }) => {
    const agents = Array.isArray(data.agents) ? data.agents : [];
    const lines = Array.isArray(data.lines) ? data.lines : [];
    setRoutingAgents(agents);
    setRoutingLines(lines);
    setManualFromNumber((current) => {
      if (lines.some((line) => line.enabled && line.phone === current)) return current;
      return lines.find((line) => line.enabled && line.isDefault)?.phone ||
        lines.find((line) => line.enabled)?.phone || "";
    });
  }, []);

  const fetchRouting = useCallback(async () => {
    setRoutingLoading(true);
    try {
      const params = new URLSearchParams({
        accessCode: getStoredAccessCode(),
        t: String(Date.now()),
      });
      const res = await fetch(`/api/call-routing?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (res.status === 401) {
        resetAuth(data.error);
        return;
      }
      if (!data.ok) throw new Error(data.error || "Unable to load call routing.");
      applyRoutingData(data);
      setRoutingError("");
    } catch (error) {
      setRoutingError(error instanceof Error ? error.message : "Unable to load call routing.");
    } finally {
      setRoutingLoading(false);
    }
  }, [applyRoutingData, getStoredAccessCode, resetAuth]);

  useEffect(() => {
    if (!isAuth || !phoneSet) return;
    const timer = window.setTimeout(() => void fetchRouting(), 0);
    const interval = window.setInterval(fetchRouting, 30000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [isAuth, phoneSet, fetchRouting]);

  async function updateRouting(
    busyKey: string,
    payload: Record<string, string | boolean | string[]>
  ): Promise<boolean> {
    setRoutingBusy(busyKey);
    setRoutingError("");
    try {
      const res = await fetch("/api/call-routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, accessCode: getStoredAccessCode() }),
      });
      const data = await res.json();
      if (res.status === 401) {
        resetAuth(data.error);
        return false;
      }
      if (!data.ok) throw new Error(data.error || "Unable to update call routing.");
      applyRoutingData(data);
      return true;
    } catch (error) {
      setRoutingError(error instanceof Error ? error.message : "Unable to update call routing.");
      return false;
    } finally {
      setRoutingBusy("");
    }
  }

  async function handleToggleCurrentAgent() {
    const phone = normalizePhone(affiliatePhone);
    const existing = routingAgents.find((agent) => agent.phone === phone);
    if (!existing) {
      setRoutingOpen(true);
      setRoutingError(`${phone} is not registered as an inbound agent.`);
      return;
    }
    await updateRouting(`agent:${phone}`, {
      type: "agent",
      phone,
      label: existing.label,
      enabled: !existing.enabled,
    });
  }

  async function handleAddAgent() {
    const phone = normalizePhone(newAgentPhone);
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      setRoutingError("Enter the agent phone in E.164 format.");
      return;
    }
    const saved = await updateRouting(`agent:${phone}`, {
      type: "agent",
      phone,
      label: newAgentLabel.trim() || "Agent",
      enabled: true,
      linePhones: newAgentLinePhone ? [newAgentLinePhone] : [],
    });
    if (saved) {
      setNewAgentPhone("");
      setNewAgentLabel("");
      setNewAgentLinePhone("");
    }
  }

  async function handleAgentLineChange(
    agent: RoutingAgent,
    linePhone: string,
    assigned: boolean
  ) {
    const allLinePhones = routingLines.map((line) => line.phone);
    const currentLines = agent.linePhones.length > 0
      ? agent.linePhones
      : allLinePhones;
    const nextLines = assigned
      ? [...new Set([...currentLines, linePhone])]
      : currentLines.filter((phone) => phone !== linePhone);

    if (nextLines.length === 0) {
      setRoutingError("An enabled agent must be assigned to at least one line. Pause the agent instead.");
      return;
    }

    await updateRouting(`agent:${agent.phone}:lines`, {
      type: "agent",
      phone: agent.phone,
      label: agent.label,
      linePhones: nextLines.length === allLinePhones.length ? [] : nextLines,
    });
  }

  async function handleAddLine() {
    const phone = normalizePhone(newLinePhone);
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      setRoutingError("Enter the Twilio line in E.164 format.");
      return;
    }
    const saved = await updateRouting(`line:${phone}`, {
      type: "line",
      phone,
      label: newLineLabel.trim() || "Inbound line",
      enabled: true,
      configureTwilio: true,
    });
    if (saved) {
      setNewLinePhone("");
      setNewLineLabel("");
    }
  }

  function handleRefresh() {
    void fetchLeads();
    void fetchLiveCalls();
    void fetchRecordings();
    void fetchRouting();
  }

  async function handleToggleFavorite(recording: CallRecording) {
    if (favoriteBusy.has(recording.sid)) return;

    const isFavorite = !recording.isFavorite;
    setFavoriteBusy((previous) => new Set(previous).add(recording.sid));
    setRecordings((previous) =>
      previous.map((item) =>
        item.sid === recording.sid ? { ...item, isFavorite } : item
      )
    );

    try {
      const res = await fetch("/api/recording-favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessCode: getStoredAccessCode(),
          favorite: isFavorite,
          recordingSid: recording.sid,
          recording,
        }),
      });
      const data = await res.json();
      if (res.status === 401) {
        resetAuth(data.error);
        return;
      }
      if (!data.ok) {
        setRecordings((previous) =>
          previous.map((item) =>
            item.sid === recording.sid
              ? { ...item, isFavorite: recording.isFavorite }
              : item
          )
        );
        setRecordingsError(data.error || "Unable to update favorite.");
        return;
      }

      await fetchRecordings();
    } catch (err) {
      console.error("Favorite recording error:", err);
      setRecordings((previous) =>
        previous.map((item) =>
          item.sid === recording.sid
            ? { ...item, isFavorite: recording.isFavorite }
            : item
        )
      );
      setRecordingsError("Unable to update favorite.");
    } finally {
      setFavoriteBusy((previous) => {
        const next = new Set(previous);
        next.delete(recording.sid);
        return next;
      });
    }
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  async function handleCall(lead: Lead) {
    if (!confirm(`Call ${lead.name} at ${lead.phone}?\n\nYour phone (${affiliatePhone}) will ring first.`)) return;

    setActionMsg({ id: lead.id, msg: "Dialing...", type: "ok" });
    try {
      const res = await fetch("/api/start-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: lead.id,
          affiliatePhone,
          accessCode: getStoredAccessCode(),
        }),
      });
      const data = await res.json();
      if (res.status === 401) {
        resetAuth(data.error);
        return;
      }
      if (data.ok) {
        setActionMsg({ id: lead.id, msg: data.message || "Calling your phone first. Pick up to connect the lead.", type: "ok" });
        setDialedLeads((prev) => new Set(prev).add(lead.id));
      } else {
        setActionMsg({ id: lead.id, msg: data.error, type: "err" });
      }
    } catch {
      setActionMsg({ id: lead.id, msg: "Network error", type: "err" });
    }
    setTimeout(() => setActionMsg(null), 5000);
  }

  async function handleMarkStatus(lead: Lead, newStatus: string) {
    // Prevent double-clicks
    if (busyLeads.has(lead.id)) return;
    setBusyLeads((prev) => new Set(prev).add(lead.id));

    // ── Optimistic update: immediately update local state ──
    const previousLeads = [...leads];
    setLeads((prev) =>
      prev.map((l) => (l.id === lead.id ? { ...l, status: newStatus } : l))
    );

    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: newStatus,
          accessCode: getStoredAccessCode(),
          affiliatePhone,
        }),
      });
      const data = await res.json();
      if (res.status === 401) {
        setLeads(previousLeads);
        resetAuth(data.error);
      } else if (data.ok) {
        // Re-fetch from Sheets to confirm sync
        fetchLeads();
        setActionMsg({ id: lead.id, msg: `Marked ${newStatus}`, type: "ok" });
      } else {
        // Revert optimistic update on failure
        setLeads(previousLeads);
        setActionMsg({ id: lead.id, msg: data.error, type: "err" });
      }
    } catch {
      // Revert optimistic update on network error
      setLeads(previousLeads);
      setActionMsg({ id: lead.id, msg: "Network error", type: "err" });
    }
    setBusyLeads((prev) => { const s = new Set(prev); s.delete(lead.id); return s; });
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function handleSaveNotes(lead: Lead, notes: string) {
    // Optimistic update
    setLeads((prev) =>
      prev.map((l) => (l.id === lead.id ? { ...l, notes } : l))
    );

    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes,
          accessCode: getStoredAccessCode(),
          affiliatePhone,
        }),
      });
      const data = await res.json();
      if (res.status === 401) {
        resetAuth(data.error);
        return;
      }
      if (data.ok) {
        setActionMsg({ id: lead.id, msg: "Notes saved", type: "ok" });
        fetchLeads();
      } else {
        setActionMsg({ id: lead.id, msg: data.error, type: "err" });
        fetchLeads(); // Re-fetch to revert
      }
    } catch {
      setActionMsg({ id: lead.id, msg: "Network error", type: "err" });
      fetchLeads(); // Re-fetch to revert
    }
    setTimeout(() => setActionMsg(null), 3000);
  }

  // ── Client-side emergency check (mirrors server block list) ─────────────────
  function isEmergencyClient(phone: string): boolean {
    const digits = phone.replace(/\D/g, "");
    const blocked = new Set([
      "911", "1911", "112", "1112", "999", "1999", "000", "1000",
      "111", "1111", "110", "1110", "119", "1119", "100", "1100",
      "102", "1102", "108", "1108", "211", "1211", "311", "1311",
      "411", "1411", "511", "1511", "611", "1611", "711", "1711", "811", "1811",
    ]);
    if (blocked.has(digits)) return true;
    if (digits.startsWith("1") && blocked.has(digits.slice(1))) return true;
    return false;
  }

  // Normalize a phone number: 10 digits → +1XXXXXXXXXX, 11 starting with 1 → +1XXXXXXXXXX
  function normalizePhone(input: string): string {
    const val = input.trim();
    if (val.startsWith("+")) return val;
    const digits = val.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return `+${digits}`;
  }

  async function handleManualDial() {
    const raw = manualNumber.trim();
    const withPlus = normalizePhone(raw);
    if (!withPlus || withPlus.length < 8) {
      setManualMsg({ msg: "Enter a valid number (e.g. +15551234567 or 5551234567)", type: "err" });
      setTimeout(() => setManualMsg(null), 4000);
      return;
    }
    if (isEmergencyClient(withPlus)) {
      setManualMsg({ msg: "Emergency and special service numbers cannot be called.", type: "err" });
      setTimeout(() => setManualMsg(null), 5000);
      return;
    }
    setManualMsg(null);
    setManualDialing(true);
    try {
      const res = await fetch("/api/dial-number", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          affiliatePhone,
          leadPhone: withPlus,
          fromNumber: manualFromNumber,
          accessCode: getStoredAccessCode(),
        }),
      });
      const data = await res.json();
      if (res.status === 401) {
        resetAuth(data.error);
      } else if (data.ok) {
        setManualMsg({
          msg: data.lineLabel
            ? `Calling your phone first from ${data.lineLabel}.`
            : data.message || "Calling your phone first. Pick up to connect.",
          type: "ok",
        });
        setManualNumber("");
      } else {
        setManualMsg({ msg: data.error || "Failed to dial", type: "err" });
      }
    } catch {
      setManualMsg({ msg: "Network error", type: "err" });
    }
    setManualDialing(false);
    setTimeout(() => setManualMsg(null), 5000);
  }

  // ── LOGIN SCREEN ────────────────────────────────────────────────────────────
  if (!isAuth) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-8 w-full max-w-sm shadow-2xl">
          <h1 className="text-xl font-bold text-white mb-1">Callback Dashboard</h1>
          <p className="text-slate-400 text-sm mb-6">Enter your access code to continue.</p>
          <input
            type="password"
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleLogin();
            }}
            placeholder="Access code"
            className="w-full px-4 py-3 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 mb-3 focus:outline-none focus:border-blue-500"
          />
          {authError && <p className="text-red-400 text-sm mb-3">{authError}</p>}
          <button
            onClick={handleLogin}
            disabled={authBusy}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition"
          >
            {authBusy ? "Checking..." : "Log In"}
          </button>
        </div>
      </div>
    );
  }

  // ── PHONE INPUT SCREEN ──────────────────────────────────────────────────────
  if (!phoneSet) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-8 w-full max-w-sm shadow-2xl">
          <h1 className="text-xl font-bold text-white mb-1">Your Phone Number</h1>
          <p className="text-slate-400 text-sm mb-6">
            This number identifies your inbound agent status and receives your outbound callback bridges.
          </p>
          <input
            type="tel"
            value={affiliatePhone}
            onChange={(e) => setAffiliatePhone(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSetPhone()}
            placeholder="+14375053539"
            className="w-full px-4 py-3 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 mb-2 focus:outline-none focus:border-blue-500"
          />
          <p className="text-slate-500 text-xs mb-4">E.164 format: + country code + number</p>
          <button
            onClick={handleSetPhone}
            className="w-full py-3 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg transition"
          >
            Continue
          </button>
          <button
            onClick={handleLogout}
            className="w-full mt-2 py-2 text-slate-400 hover:text-white text-sm transition"
          >
            Log out
          </button>
        </div>
      </div>
    );
  }

  // Normalized manual number for emergency check
  const manualNormalized = manualNumber.trim() ? normalizePhone(manualNumber.trim()) : "";
  const isManualEmergency = manualNormalized.length >= 3 && isEmergencyClient(manualNormalized);
  const favoriteCount = recordings.filter((recording) => recording.isFavorite).length;
  const visibleRecordings =
    recordingsView === "favorites"
      ? recordings.filter((recording) => recording.isFavorite)
      : recordings;
  const activeRoutingLines = routingLines.filter((line) => line.enabled);
  const normalizedAffiliatePhone = normalizePhone(affiliatePhone);
  const currentRoutingAgent = routingAgents.find(
    (agent) => agent.phone === normalizedAffiliatePhone
  );
  const receivingCalls = currentRoutingAgent?.enabled === true;

  function leadLineLabel(calledNumber: string): string {
    if (!calledNumber) return "Default";
    return routingLines.find((line) => line.phone === calledNumber)?.label || calledNumber;
  }

  // ── MAIN DASHBOARD ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-700 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">Callback Dashboard</h1>
          <p className="text-slate-400 text-xs">
            Your phone: <span className="text-white">{affiliatePhone}</span>
            <button onClick={handleChangePhone} className="ml-2 text-blue-400 hover:text-blue-300 underline">
              change
            </button>
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={receivingCalls}
            aria-label={currentRoutingAgent
              ? `${receivingCalls ? "Pause" : "Resume"} inbound calls for ${normalizedAffiliatePhone}`
              : `${normalizedAffiliatePhone} is not registered for inbound calls`}
            onClick={() => void handleToggleCurrentAgent()}
            disabled={!currentRoutingAgent || routingBusy === `agent:${normalizedAffiliatePhone}` || routingLoading}
            className={`min-w-36 px-3 py-1.5 rounded-lg transition disabled:opacity-70 ${
              !currentRoutingAgent
                ? "bg-slate-700 text-slate-300 cursor-not-allowed"
                : receivingCalls
                ? "bg-emerald-700 hover:bg-emerald-600 text-white"
                : "bg-amber-700 hover:bg-amber-600 text-white"
            }`}
            title={!currentRoutingAgent
              ? `${normalizedAffiliatePhone} is not registered as an inbound agent`
              : receivingCalls
                ? `Pause inbound calls to ${normalizedAffiliatePhone}`
                : `Resume inbound calls to ${normalizedAffiliatePhone}`}
          >
            <span className="block text-sm">
              {routingBusy === `agent:${normalizedAffiliatePhone}`
                ? "Updating..."
                : !currentRoutingAgent
                  ? "Not Routed"
                  : receivingCalls
                    ? "Receiving Calls"
                    : "Calls Paused"}
            </span>
            <span className="block text-[10px] font-mono opacity-80">
              {normalizedAffiliatePhone}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setRoutingOpen((open) => !open)}
            className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 rounded-lg transition"
          >
            Routing
          </button>
          {pushSupported && (
            <button
              onClick={pushSubscribed ? handleDisablePush : handleEnablePush}
              disabled={pushBusy || pushPermission === "denied"}
              className={`px-3 py-1.5 text-sm rounded-lg transition disabled:opacity-50 ${
                pushSubscribed
                  ? "bg-green-700 hover:bg-green-600 text-white"
                  : pushPermission === "denied"
                    ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                    : "bg-amber-700 hover:bg-amber-600 text-white"
              }`}
              title={
                pushPermission === "denied"
                  ? "Notifications blocked in browser settings"
                  : pushSubscribed
                    ? "Push notifications enabled"
                    : "Enable push notifications"
              }
            >
              {pushBusy
                ? "..."
                : pushPermission === "denied"
                  ? "Blocked"
                  : pushSubscribed
                    ? "Notifs ON"
                    : "Notifs OFF"}
            </button>
          )}
          <button
            onClick={handleRefresh}
            className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 rounded-lg transition"
          >
            Refresh
          </button>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-sm text-slate-400 hover:text-white border border-slate-600 rounded-lg transition"
          >
            Log out
          </button>
        </div>
      </header>

      {routingOpen && (
        <section className="border-b border-slate-700 bg-slate-900/70">
          <div className="px-4 py-3 flex flex-wrap items-center gap-3 border-b border-slate-800">
            <h2 className="text-sm font-semibold text-white">Call Routing</h2>
            <span className="text-xs text-slate-400">
              {routingAgents.filter((agent) => agent.enabled).length} agents active
            </span>
            <button
              type="button"
              onClick={() => void fetchRouting()}
              disabled={routingLoading}
              className="ml-auto px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded-lg disabled:opacity-50"
            >
              {routingLoading ? "Loading..." : "Refresh"}
            </button>
          </div>

          {routingError && (
            <p className="px-4 pt-3 text-sm text-red-400">{routingError}</p>
          )}

          <div className="grid md:grid-cols-2">
            <div className="px-4 py-4 md:border-r border-slate-800">
              <h3 className="text-xs uppercase text-slate-400 mb-3">Twilio Lines</h3>
              <div className="divide-y divide-slate-800 border-y border-slate-800">
                {routingLines.map((line) => (
                  <div key={line.phone} className="py-3 flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-white truncate">
                        {line.label}
                        {line.isDefault && (
                          <span className="ml-2 text-[10px] uppercase text-blue-300">Default</span>
                        )}
                      </p>
                      <p className="text-xs text-slate-400 font-mono">{line.phone}</p>
                    </div>
                    {!line.isDefault && line.enabled && (
                      <button
                        type="button"
                        onClick={() => void updateRouting(`line:${line.phone}`, {
                          type: "line",
                          phone: line.phone,
                          isDefault: true,
                        })}
                        disabled={routingBusy === `line:${line.phone}`}
                        className="text-xs text-blue-300 hover:text-blue-200 disabled:opacity-50"
                      >
                        Make default
                      </button>
                    )}
                    <RoutingToggle
                      enabled={line.enabled}
                      busy={routingBusy === `line:${line.phone}`}
                      label={`${line.label} line`}
                      onChange={() => void updateRouting(`line:${line.phone}`, {
                        type: "line",
                        phone: line.phone,
                        enabled: !line.enabled,
                      })}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-3 grid sm:grid-cols-[1fr_1fr_auto] gap-2">
                <input
                  type="text"
                  value={newLineLabel}
                  onChange={(event) => setNewLineLabel(event.target.value)}
                  placeholder="Line name"
                  className="min-w-0 px-3 py-2 text-sm bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:border-blue-500"
                />
                <input
                  type="tel"
                  value={newLinePhone}
                  onChange={(event) => setNewLinePhone(event.target.value)}
                  placeholder="+18445551234"
                  className="min-w-0 px-3 py-2 text-sm font-mono bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  onClick={() => void handleAddLine()}
                  disabled={!newLinePhone.trim() || routingBusy.startsWith("line:")}
                  className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-50"
                >
                  Add line
                </button>
              </div>
            </div>

            <div className="px-4 py-4">
              <h3 className="text-xs uppercase text-slate-400 mb-3">Inbound Agents</h3>
              <div className="divide-y divide-slate-800 border-y border-slate-800">
                {routingAgents.map((agent) => (
                  <div key={agent.phone} className="py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white truncate">
                          {agent.label}
                          {agent.phone === normalizedAffiliatePhone && (
                            <span className="ml-2 text-[10px] uppercase text-blue-300">This phone</span>
                          )}
                        </p>
                        <p className="text-xs text-slate-400 font-mono">{agent.phone}</p>
                      </div>
                      <RoutingToggle
                        enabled={agent.enabled}
                        busy={routingBusy.startsWith(`agent:${agent.phone}`)}
                        label={agent.label}
                        onChange={() => void updateRouting(`agent:${agent.phone}`, {
                          type: "agent",
                          phone: agent.phone,
                          enabled: !agent.enabled,
                        })}
                      />
                      <button
                        type="button"
                        onClick={() => void updateRouting(`agent:${agent.phone}`, {
                          action: "remove",
                          type: "agent",
                          phone: agent.phone,
                        })}
                        disabled={routingBusy.startsWith(`agent:${agent.phone}`)}
                        className="text-xs text-red-300 hover:text-red-200 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <span className="text-[10px] uppercase text-slate-500">Receives</span>
                      {routingLines.map((line) => {
                        const assigned =
                          agent.linePhones.length === 0 || agent.linePhones.includes(line.phone);
                        return (
                          <label key={line.phone} className="flex items-center gap-1.5 text-xs text-slate-300">
                            <input
                              type="checkbox"
                              checked={assigned}
                              onChange={(event) => void handleAgentLineChange(
                                agent,
                                line.phone,
                                event.target.checked
                              )}
                              disabled={routingBusy.startsWith(`agent:${agent.phone}`)}
                              className="h-4 w-4 accent-blue-500"
                            />
                            {line.label}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] gap-2">
                <input
                  type="text"
                  value={newAgentLabel}
                  onChange={(event) => setNewAgentLabel(event.target.value)}
                  placeholder="Agent name"
                  className="min-w-0 px-3 py-2 text-sm bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:border-blue-500"
                />
                <input
                  type="tel"
                  value={newAgentPhone}
                  onChange={(event) => setNewAgentPhone(event.target.value)}
                  placeholder="+14375551234"
                  className="min-w-0 px-3 py-2 text-sm font-mono bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:border-blue-500"
                />
                <select
                  value={newAgentLinePhone}
                  onChange={(event) => setNewAgentLinePhone(event.target.value)}
                  aria-label="Inbound line assignment"
                  className="min-w-0 px-3 py-2 text-sm bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:border-blue-500"
                >
                  <option value="">All inbound lines</option>
                  {routingLines.map((line) => (
                    <option key={line.phone} value={line.phone}>
                      {line.label} only
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void handleAddAgent()}
                  disabled={!newAgentPhone.trim() || routingBusy.startsWith("agent:")}
                  className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-50"
                >
                  Add agent
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Manual dial (keypad) */}
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/50">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <p className="text-slate-400 text-xs uppercase tracking-wider">Dial any number</p>
          <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
            Caller ID
            <select
              value={manualFromNumber}
              onChange={(event) => setManualFromNumber(event.target.value)}
              disabled={activeRoutingLines.length === 0}
              className="max-w-[220px] px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
            >
              {activeRoutingLines.map((line) => (
                <option key={line.phone} value={line.phone}>
                  {line.label} ({line.phone})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 mb-3">
          <input
            type="tel"
            value={manualNumber}
            onChange={(e) => setManualNumber(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleManualDial()}
            placeholder="+1 555 123 4567"
            className="flex-1 px-3 py-2.5 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono text-lg"
          />
          <button
            onClick={handleManualDial}
            disabled={manualDialing || isManualEmergency}
            className="px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition shrink-0"
          >
            {manualDialing ? "Dialing…" : "Dial"}
          </button>
        </div>
        {/* On-screen keypad */}
        <div className="grid grid-cols-3 gap-2 max-w-[240px]">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "0", "⌫"].map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                if (key === "⌫") {
                  setManualNumber((n) => n.slice(0, -1));
                } else {
                  setManualNumber((n) => n + key);
                }
              }}
              className="py-3 bg-slate-700 hover:bg-slate-600 active:bg-slate-500 rounded-lg text-white font-mono text-lg transition"
            >
              {key}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setManualNumber("")}
          className="mt-2 text-slate-400 hover:text-white text-sm"
        >
          Clear
        </button>
        {isManualEmergency && (
          <p className="text-amber-400 text-sm mt-2">Emergency and special service numbers cannot be called.</p>
        )}
        {manualMsg && (
          <p className={`text-sm mt-2 ${manualMsg.type === "ok" ? "text-green-400" : "text-red-400"}`}>
            {manualMsg.msg}
          </p>
        )}
      </div>

      {/* Live Calls Panel */}
      <div className="px-4 py-3 border-b border-slate-800">
        <button
          onClick={() => setLiveCallsOpen(!liveCallsOpen)}
          className="flex items-center gap-2 w-full text-left"
        >
          <span className="text-slate-400 text-xs uppercase tracking-wider">
            Live Calls
          </span>
          {liveCalls.length > 0 && (
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
            </span>
          )}
          <span className="text-slate-500 text-xs">
            {liveCalls.length > 0
              ? `${liveCalls.length} active`
              : "None"}
          </span>
          <span className="text-slate-500 text-xs ml-auto">
            {liveCallsOpen ? "▲" : "▼"}
          </span>
        </button>

        {liveCallsOpen && (
          <div className="mt-3">
            {liveCalls.length === 0 ? (
              <p className="text-slate-600 text-sm py-2">
                No agents on live calls right now.
              </p>
            ) : (
              <div className="space-y-2">
                {(() => {
                  const grouped = new Map<string, LiveCall[]>();
                  for (const c of liveCalls) {
                    const key = c.conferenceName;
                    if (!grouped.has(key)) grouped.set(key, []);
                    grouped.get(key)!.push(c);
                  }
                  return Array.from(grouped.entries()).map(([conf, agents]) => (
                    <div
                      key={conf}
                      className="bg-green-950/40 border border-green-800/50 rounded-lg p-3"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                        </span>
                        <span className="text-green-300 text-xs font-mono truncate">
                          {conf}
                        </span>
                        <span className="text-green-500/60 text-xs ml-auto">
                          Caller: {agents[0]?.callerNumber || "—"}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        {agents.map((agent) => (
                          <div
                            key={agent.agentNumber + agent.conferenceName}
                            className="flex items-center gap-2"
                          >
                            <span className="text-white text-sm font-mono">
                              {agent.agentNumber}
                            </span>
                            <LiveDuration startTime={agent.startTime} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recorded Calls Panel */}
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-950/40">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRecordingsOpen(!recordingsOpen)}
            className="flex items-center gap-2 min-w-0 flex-1 text-left"
          >
            <span className="text-slate-400 text-xs uppercase tracking-wider">
              Call Recordings
            </span>
            <span className="text-slate-500 text-xs">
              {recordingsLoading
                ? "Loading..."
                : `${recordingRecentCount} recent / ${favoriteCount} saved`}
            </span>
            <span className="text-slate-500 text-xs ml-auto">
              {recordingsOpen ? "Hide" : "Show"}
            </span>
          </button>
          <button
            type="button"
            onClick={() => void fetchRecordings()}
            disabled={recordingsLoading}
            className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg transition"
          >
            Refresh
          </button>
        </div>

        {recordingsOpen && (
          <div className="mt-3">
            <div className="flex gap-1 mb-3" role="tablist" aria-label="Recording views">
              <button
                type="button"
                role="tab"
                aria-selected={recordingsView === "all"}
                onClick={() => setRecordingsView("all")}
                className={`px-3 py-1.5 text-xs rounded font-medium transition ${
                  recordingsView === "all"
                    ? "bg-blue-600 text-white"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                All
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={recordingsView === "favorites"}
                onClick={() => setRecordingsView("favorites")}
                className={`px-3 py-1.5 text-xs rounded font-medium transition ${
                  recordingsView === "favorites"
                    ? "bg-amber-600 text-white"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                Favorites ({favoriteCount})
              </button>
            </div>
            {recordingsError && (
              <p className="text-red-400 text-sm py-2">{recordingsError}</p>
            )}
            {!recordingsError && visibleRecordings.length === 0 && !recordingsLoading && (
              <p className="text-slate-600 text-sm py-2">
                {recordingsView === "favorites"
                  ? "No favorite recordings yet."
                  : "No connected call recordings in the last 7 days."}
              </p>
            )}
            {visibleRecordings.length > 0 && (
              <div className="space-y-2">
                {visibleRecordings.map((recording) => (
                  <div
                    key={recording.sid}
                    className="bg-slate-900 border border-slate-800 rounded-lg p-3"
                  >
                    <div className="flex flex-col lg:flex-row lg:items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                              recording.direction === "inbound"
                                ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                                : "bg-sky-950 text-sky-300 border border-sky-800"
                            }`}
                          >
                            {recording.direction === "inbound" ? "Inbound" : "Outbound"}
                          </span>
                          <p className="text-white text-sm font-semibold truncate">
                            {formatRecordingTitle(recording)}
                          </p>
                        </div>
                        <p className="text-slate-500 text-xs">
                          {formatDate(recording.dateCreated)} - {formatRecordingDuration(recording.duration)} -{" "}
                          {formatRecordingVerification(recording)}
                        </p>
                        <p className="text-slate-600 text-[11px] font-mono truncate">
                          {recording.conferenceName || recording.callSid || recording.sid}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleToggleFavorite(recording)}
                        disabled={favoriteBusy.has(recording.sid)}
                        aria-pressed={recording.isFavorite}
                        aria-label={
                          recording.isFavorite
                            ? "Remove recording from favorites"
                            : "Save recording to favorites"
                        }
                        title={
                          recording.isFavorite
                            ? "Remove from favorites"
                            : "Save to favorites"
                        }
                        className={`w-9 h-9 shrink-0 self-end lg:self-auto flex items-center justify-center rounded border transition disabled:opacity-50 ${
                          recording.isFavorite
                            ? "bg-amber-950 text-amber-300 border-amber-700 hover:bg-amber-900"
                            : "bg-slate-950 text-slate-400 border-slate-700 hover:text-amber-300 hover:border-amber-700"
                        }`}
                      >
                        <span aria-hidden="true" className="text-xl leading-none">
                          {recording.isFavorite ? "\u2605" : "\u2606"}
                        </span>
                      </button>
                      <audio
                        controls
                        preload="none"
                        className="w-full lg:w-[360px] h-9"
                        src={`/api/recordings/${recording.sid}/media?accessCode=${encodeURIComponent(
                          getStoredAccessCode()
                        )}`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="px-4 py-3 flex flex-col sm:flex-row gap-3 border-b border-slate-800">
        {/* Status tabs */}
        <div className="flex gap-1">
          {["pending", "called", "all"].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-sm rounded-lg font-medium transition ${
                statusFilter === s
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:text-white"
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or phone..."
          className="flex-1 px-3 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />

        {/* Sort */}
        <button
          onClick={() => setSortOrder(sortOrder === "desc" ? "asc" : "desc")}
          className="px-3 py-1.5 text-sm bg-slate-800 text-slate-400 hover:text-white rounded-lg transition"
        >
          Date: {sortOrder === "desc" ? "Newest" : "Oldest"}
        </button>
      </div>

      {/* Lead list */}
      <main className="p-4">
        {loading && leads.length === 0 && (
          <p className="text-slate-500 text-center py-10">Loading...</p>
        )}

        {!loading && leads.length === 0 && (
          <p className="text-slate-500 text-center py-10">
            No leads found. {statusFilter !== "all" && "Try switching to \"All\"."}
          </p>
        )}

        {/* Desktop table */}
        <div className="hidden md:block">
          {leads.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 text-xs uppercase border-b border-slate-800">
                  <th className="text-left py-2 px-2">Name</th>
                  <th className="text-left py-2 px-2">Phone</th>
                  <th className="text-left py-2 px-2">Reason</th>
                  <th className="text-left py-2 px-2">Line</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2">Created</th>
                  <th className="text-left py-2 px-2">Notes</th>
                  <th className="text-left py-2 px-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <LeadRow
                    key={lead.id}
                    lead={lead}
                    lineLabel={leadLineLabel(lead.calledNumber)}
                    onCall={handleCall}
                    onMark={handleMarkStatus}
                    onSaveNotes={handleSaveNotes}
                    actionMsg={actionMsg?.id === lead.id ? actionMsg : null}
                    busy={busyLeads.has(lead.id)}
                    dialed={dialedLeads.has(lead.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Mobile cards */}
        <div className="md:hidden space-y-3">
          {leads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              lineLabel={leadLineLabel(lead.calledNumber)}
              onCall={handleCall}
              onMark={handleMarkStatus}
              onSaveNotes={handleSaveNotes}
              actionMsg={actionMsg?.id === lead.id ? actionMsg : null}
              busy={busyLeads.has(lead.id)}
              dialed={dialedLeads.has(lead.id)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

// ── Desktop Row Component ─────────────────────────────────────────────────────
function RoutingToggle({
  enabled,
  busy,
  label,
  onChange,
}: {
  enabled: boolean;
  busy: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${enabled ? "Disable" : "Enable"} ${label}`}
      title={`${enabled ? "Disable" : "Enable"} ${label}`}
      onClick={onChange}
      disabled={busy}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
        enabled ? "bg-emerald-600" : "bg-slate-600"
      }`}
    >
      <span
        className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform ${
          enabled ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function LeadRow({
  lead,
  lineLabel,
  onCall,
  onMark,
  onSaveNotes,
  actionMsg,
  busy,
  dialed,
}: {
  lead: Lead;
  lineLabel: string;
  onCall: (l: Lead) => void;
  onMark: (l: Lead, status: string) => void;
  onSaveNotes: (l: Lead, notes: string) => void;
  actionMsg: { msg: string; type: "ok" | "err" } | null;
  busy?: boolean;
  dialed?: boolean;
}) {
  const [notes, setNotes] = useState(lead.notes);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setNotes(lead.notes), 0);
    return () => window.clearTimeout(timer);
  }, [lead.notes]);

  return (
    <tr className="border-b border-slate-800/50 hover:bg-slate-900/50">
      <td className="py-3 px-2 font-medium">{lead.name}</td>
      <td className="py-3 px-2 text-slate-300 font-mono text-xs">{lead.phone}</td>
      <td className="py-3 px-2 text-slate-400 max-w-[150px] truncate">{lead.reason}</td>
      <td className="py-3 px-2 text-slate-400 text-xs">{lineLabel}</td>
      <td className="py-3 px-2">
        <div className="flex items-center gap-1.5">
          <StatusBadge status={lead.status} />
          {dialed && lead.status === "pending" && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-900/50 text-blue-300 border border-blue-700">
              dialed
            </span>
          )}
        </div>
      </td>
      <td className="py-3 px-2 text-slate-400 text-xs">
        {formatDate(lead.createdAt)}
      </td>
      <td className="py-3 px-2 max-w-[200px]">
        {editing ? (
          <div className="flex gap-1">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="flex-1 px-2 py-1 text-xs bg-slate-800 border border-slate-600 rounded text-white focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onSaveNotes(lead, notes);
                  setEditing(false);
                }
              }}
            />
            <button
              onClick={() => { onSaveNotes(lead, notes); setEditing(false); }}
              className="px-2 py-1 text-xs bg-blue-600 rounded text-white"
            >
              Save
            </button>
          </div>
        ) : (
          <span
            onClick={() => setEditing(true)}
            className="text-slate-400 text-xs cursor-pointer hover:text-white truncate block"
            title="Click to edit"
          >
            {notes || "—"}
          </span>
        )}
      </td>
      <td className="py-3 px-2">
        <div className="flex gap-1 items-center">
          <button
            onClick={() => onCall(lead)}
            className={`px-2 py-1 text-xs rounded font-semibold transition ${
              dialed ? "bg-slate-600 hover:bg-slate-500" : "bg-green-600 hover:bg-green-500"
            }`}
          >
            {dialed ? "Call Again" : "Call"}
          </button>
          {lead.status === "pending" ? (
            <button
              onClick={() => onMark(lead, "called")}
              disabled={busy}
              className={`px-2 py-1 text-xs rounded transition disabled:opacity-50 disabled:cursor-not-allowed ${
                dialed
                  ? "bg-green-700 hover:bg-green-600 text-white font-semibold"
                  : "bg-slate-700 hover:bg-slate-600"
              }`}
            >
              {busy ? "Updating…" : "Mark Called"}
            </button>
          ) : (
            <button
              onClick={() => onMark(lead, "pending")}
              disabled={busy}
              className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "Updating…" : "Mark Pending"}
            </button>
          )}
        </div>
        {actionMsg && (
          <p className={`text-xs mt-1 ${actionMsg.type === "ok" ? "text-green-400" : "text-red-400"}`}>
            {actionMsg.msg}
          </p>
        )}
      </td>
    </tr>
  );
}

// ── Mobile Card Component ─────────────────────────────────────────────────────
function LeadCard({
  lead,
  lineLabel,
  onCall,
  onMark,
  onSaveNotes,
  actionMsg,
  busy,
  dialed,
}: {
  lead: Lead;
  lineLabel: string;
  onCall: (l: Lead) => void;
  onMark: (l: Lead, status: string) => void;
  onSaveNotes: (l: Lead, notes: string) => void;
  actionMsg: { msg: string; type: "ok" | "err" } | null;
  busy?: boolean;
  dialed?: boolean;
}) {
  const [notes, setNotes] = useState(lead.notes);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setNotes(lead.notes), 0);
    return () => window.clearTimeout(timer);
  }, [lead.notes]);

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl p-4">
      <div className="flex justify-between items-start mb-2">
        <div>
          <h3 className="font-semibold text-white">{lead.name}</h3>
          <p className="text-slate-400 text-sm font-mono">{lead.phone}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={lead.status} />
          {dialed && lead.status === "pending" && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-900/50 text-blue-300 border border-blue-700">
              dialed
            </span>
          )}
        </div>
      </div>

      {lead.reason && (
        <p className="text-slate-400 text-sm mb-2">{lead.reason}</p>
      )}
      <p className="text-slate-500 text-xs mb-2">Line: {lineLabel}</p>

      <p className="text-slate-500 text-xs mb-3">
        {formatDate(lead.createdAt)}
        {lead.calledAt && ` • Called ${formatDate(lead.calledAt)}`}
      </p>

      {/* Notes */}
      <div className="mb-3">
        {editing ? (
          <div className="flex gap-2">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="flex-1 px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg text-white focus:outline-none"
              placeholder="Add notes..."
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onSaveNotes(lead, notes);
                  setEditing(false);
                }
              }}
            />
            <button
              onClick={() => { onSaveNotes(lead, notes); setEditing(false); }}
              className="px-3 py-2 text-sm bg-blue-600 rounded-lg text-white"
            >
              Save
            </button>
          </div>
        ) : (
          <p
            onClick={() => setEditing(true)}
            className="text-slate-500 text-sm cursor-pointer hover:text-slate-300"
          >
            {notes || "Tap to add notes..."}
          </p>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => onCall(lead)}
          className={`flex-1 py-2.5 rounded-lg font-semibold text-sm transition ${
            dialed ? "bg-slate-600 hover:bg-slate-500" : "bg-green-600 hover:bg-green-500"
          }`}
        >
          {dialed ? "Call Again" : "Call"}
        </button>
        {lead.status === "pending" ? (
          <button
            onClick={() => onMark(lead, "called")}
            disabled={busy}
            className={`py-2.5 px-4 rounded-lg text-sm transition disabled:opacity-50 disabled:cursor-not-allowed ${
              dialed
                ? "bg-green-700 hover:bg-green-600 text-white font-semibold"
                : "bg-slate-700 hover:bg-slate-600"
            }`}
          >
            {busy ? "Updating…" : "Mark Called"}
          </button>
        ) : (
          <button
            onClick={() => onMark(lead, "pending")}
            disabled={busy}
            className="py-2.5 px-4 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Updating…" : "Mark Pending"}
          </button>
        )}
      </div>

      {actionMsg && (
        <p className={`text-xs mt-2 ${actionMsg.type === "ok" ? "text-green-400" : "text-red-400"}`}>
          {actionMsg.msg}
        </p>
      )}
    </div>
  );
}

// ── Shared Components ─────────────────────────────────────────────────────────

function LiveDuration({ startTime }: { startTime: string }) {
  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    function update() {
      if (!startTime) { setElapsed("—"); return; }
      const start = new Date(startTime).getTime();
      if (isNaN(start)) { setElapsed("—"); return; }
      const diffSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const m = Math.floor(diffSec / 60);
      const s = diffSec % 60;
      setElapsed(`${m}:${s.toString().padStart(2, "0")}`);
    }
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startTime]);

  return (
    <span className="text-green-400 text-xs font-mono tabular-nums">
      {elapsed}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles =
    status === "pending"
      ? "bg-amber-900/50 text-amber-300 border-amber-700"
      : "bg-green-900/50 text-green-300 border-green-700";
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${styles}`}>
      {status}
    </span>
  );
}

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray.buffer as ArrayBuffer;
}

function formatDate(raw: string): string {
  return formatDateValue(raw);
}

function formatRecordingTitle(recording: CallRecording): string {
  if (recording.verification === "conference-bridge" && recording.customerPhone) {
    return `Inbound call from ${recording.customerPhone}`;
  }
  if (recording.agentPhone || recording.customerPhone) {
    return `${recording.agentPhone || "Agent"} -> ${recording.customerPhone || "Customer"}`;
  }
  if (recording.conferenceName) {
    return `Conference ${recording.conferenceName}`;
  }
  return recording.sid;
}

function formatRecordingVerification(recording: CallRecording): string {
  if (recording.verification === "conference-bridge") return "Agent joined conference";
  if (recording.verification === "human-detected") return "Human answer verified";
  return "Connected call";
}

function formatRecordingDuration(duration: string): string {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
