"use client";

import { useState, useEffect, useCallback } from "react";

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

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  // Auth state
  const [accessCode, setAccessCode] = useState("");
  const [isAuth, setIsAuth] = useState(false);
  const [authError, setAuthError] = useState("");

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

  // Live calls
  const [liveCalls, setLiveCalls] = useState<LiveCall[]>([]);
  const [liveCallsOpen, setLiveCallsOpen] = useState(true);

  // Push notifications
  const [pushSupported, setPushSupported] = useState(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>("default");
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  // ── Restore from localStorage ───────────────────────────────────────────────
  useEffect(() => {
    const savedAuth = localStorage.getItem("cb_auth");
    const savedCode = localStorage.getItem("cb_code");
    const savedPhone = localStorage.getItem("cb_phone");
    if (savedAuth === "true" && savedCode) {
      setAccessCode(savedCode);
      setIsAuth(true);
    }
    if (savedPhone) {
      setAffiliatePhone(savedPhone);
      setPhoneSet(true);
    }
  }, []);

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
  function handleLogin() {
    if (!accessCode.trim()) {
      setAuthError("Enter the access code.");
      return;
    }
    // We store the code and validate server-side on every action
    localStorage.setItem("cb_auth", "true");
    localStorage.setItem("cb_code", accessCode.trim());
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
    const cleaned = affiliatePhone.trim();
    if (!cleaned.startsWith("+") || cleaned.length < 8) {
      alert("Phone must be E.164 format, e.g. +14375053539");
      return;
    }
    localStorage.setItem("cb_phone", cleaned);
    setAffiliatePhone(cleaned);
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
      });
      const res = await fetch(`/api/leads?${params}&t=${Date.now()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.ok) setLeads(data.leads);
      else console.error("Fetch leads error:", data.error);
    } catch (err) {
      console.error("Fetch leads error:", err);
    }
    setLoading(false);
  }, [statusFilter, search, sortOrder]);

  useEffect(() => {
    if (isAuth && phoneSet) fetchLeads();
  }, [isAuth, phoneSet, fetchLeads]);

  // Auto-refresh every 30s (Google Sheets API has a 60 reads/min quota)
  useEffect(() => {
    if (!isAuth || !phoneSet) return;
    const interval = setInterval(fetchLeads, 30000);
    return () => clearInterval(interval);
  }, [isAuth, phoneSet, fetchLeads]);

  // ── Live Calls ─────────────────────────────────────────────────────────────
  const fetchLiveCalls = useCallback(async () => {
    try {
      const res = await fetch("/api/live-calls?status=LIVE&t=" + Date.now(), {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.ok) setLiveCalls(data.calls);
    } catch (err) {
      console.error("Fetch live calls error:", err);
    }
  }, []);

  useEffect(() => {
    if (isAuth && phoneSet) fetchLiveCalls();
  }, [isAuth, phoneSet, fetchLiveCalls]);

  useEffect(() => {
    if (!isAuth || !phoneSet) return;
    const interval = setInterval(fetchLiveCalls, 5000);
    return () => clearInterval(interval);
  }, [isAuth, phoneSet, fetchLiveCalls]);

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
          accessCode: localStorage.getItem("cb_code"),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setActionMsg({ id: lead.id, msg: "Your phone is ringing! Mark as called when done.", type: "ok" });
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
          accessCode: localStorage.getItem("cb_code"),
          affiliatePhone,
        }),
      });
      const data = await res.json();
      if (data.ok) {
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
          accessCode: localStorage.getItem("cb_code"),
          affiliatePhone,
        }),
      });
      const data = await res.json();
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
    let val = input.trim();
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
          accessCode: localStorage.getItem("cb_code"),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setManualMsg({ msg: "Your phone is ringing! Pick up to connect.", type: "ok" });
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
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            placeholder="Access code"
            className="w-full px-4 py-3 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 mb-3 focus:outline-none focus:border-blue-500"
          />
          {authError && <p className="text-red-400 text-sm mb-3">{authError}</p>}
          <button
            onClick={handleLogin}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition"
          >
            Log In
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
            When you click &quot;Call&quot;, we call YOUR phone first, then bridge to the lead.
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
        <div className="flex items-center gap-2">
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
            onClick={fetchLeads}
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

      {/* Manual dial (keypad) */}
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/50">
        <p className="text-slate-400 text-xs uppercase tracking-wider mb-2">Dial any number</p>
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
function LeadRow({
  lead,
  onCall,
  onMark,
  onSaveNotes,
  actionMsg,
  busy,
  dialed,
}: {
  lead: Lead;
  onCall: (l: Lead) => void;
  onMark: (l: Lead, status: string) => void;
  onSaveNotes: (l: Lead, notes: string) => void;
  actionMsg: { msg: string; type: "ok" | "err" } | null;
  busy?: boolean;
  dialed?: boolean;
}) {
  const [notes, setNotes] = useState(lead.notes);
  const [editing, setEditing] = useState(false);

  useEffect(() => setNotes(lead.notes), [lead.notes]);

  return (
    <tr className="border-b border-slate-800/50 hover:bg-slate-900/50">
      <td className="py-3 px-2 font-medium">{lead.name}</td>
      <td className="py-3 px-2 text-slate-300 font-mono text-xs">{lead.phone}</td>
      <td className="py-3 px-2 text-slate-400 max-w-[150px] truncate">{lead.reason}</td>
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
  onCall,
  onMark,
  onSaveNotes,
  actionMsg,
  busy,
  dialed,
}: {
  lead: Lead;
  onCall: (l: Lead) => void;
  onMark: (l: Lead, status: string) => void;
  onSaveNotes: (l: Lead, notes: string) => void;
  actionMsg: { msg: string; type: "ok" | "err" } | null;
  busy?: boolean;
  dialed?: boolean;
}) {
  const [notes, setNotes] = useState(lead.notes);
  const [editing, setEditing] = useState(false);

  useEffect(() => setNotes(lead.notes), [lead.notes]);

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
  if (!raw) return "—";
  try {
    let d: Date;
    // Handle DD/MM/YYYY HH:MM:SS format from Google Sheets
    const ddmmMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):?(\d{2})?/);
    if (ddmmMatch) {
      const [, day, month, year, hour, min, sec] = ddmmMatch;
      d = new Date(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        parseInt(hour), parseInt(min), parseInt(sec || "0")
      );
    } else {
      d = new Date(raw);
    }
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return raw;
  }
}
