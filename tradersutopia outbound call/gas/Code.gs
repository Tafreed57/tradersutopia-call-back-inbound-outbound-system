/**
 * Google Apps Script — Traders Utopia Inbound Call Events
 *
 * Receives POST events from Twilio Functions:
 *   1. callback_requested  → appends row to "Callback Queue"
 *   2. agent_on_call       → appends LIVE row to "Live Calls"
 *   3. agent_call_ended    → updates matching LIVE row to ENDED
 *
 * Deploy as Web App → Execute as: Me, Who has access: Anyone.
 * The published URL goes into CALLBACK_SCRIPT_URL env var on Twilio.
 */

const SPREADSHEET_ID = "1LI71rRtGbdPQ8wgSD-QIobDvOc5Yro0lTYgW3_eMDKs";
const SHEET_NAME = "Callback Queue";
const LIVE_CALLS_TAB = "Live Calls";

const VERCEL_PUSH_URL = "https://tradersutopia-callback-dashboard.vercel.app/api/push/send";
const PUSH_SEND_SECRET = "tu-push-secret-2026";


const LIVE_CALLS_HEADERS = [
  "Agent Number",
  "Conference Name",
  "Caller Number",
  "Start Time",
  "Status",
  "Call Duration",
  "End Time"
];

function doPost(e) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // Safe parse (handles JSON and fallback) — preserved from original
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      data = e.parameter || {};
    }

    const event = data.event || data.tag || "callback_requested";

    switch (event) {
      case "agent_on_call":
        handleAgentOnCall(ss, data);
        break;
      case "agent_call_ended":
        handleAgentCallEnded(ss, data);
        break;
      default:
        // Original callback_requested behavior (also catches any unknown event)
        handleCallbackRequested(ss, data, event);
        break;
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput("OK - Callback webhook is live. Send a POST to write to the sheet.")
    .setMimeType(ContentService.MimeType.TEXT);
}

// ── Event Handlers ───────────────────────────────────────────────────────────

/**
 * callback_requested — caller requests a callback.
 *
 * Deduplication: if the same caller number already has a row, update it
 * in-place (reset status to NEW, refresh timestamp/callSid) rather than
 * appending a duplicate. The row keeps its existing notes and assigned_to.
 *
 * Columns: A=created_at, B=caller, C=tag, D=status, E=assigned_to,
 *          F=notes, G=call_sid, H=called_number, I=digits
 */
function handleCallbackRequested(ss, data, tag) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error("Sheet tab not found: " + SHEET_NAME);

    const createdAt = new Date();
    const caller = data.caller || data.From || "";
    const calledNumber = data.called_number || data.To || "";
    const callSid = data.call_sid || data.CallSid || "";
    const digits = data.digits || data.Digits || "";

    const normalize = (n) => String(n).trim().replace(/^\+/, "").replace(/\D/g, "");
    const incomingCaller = normalize(caller);

    if (!incomingCaller) {
      sheet.appendRow([createdAt, caller, tag, "NEW", "", "", callSid, calledNumber, digits]);
      return;
    }

    // Search for existing row with same caller number
    const lastRow = sheet.getLastRow();
    let matchRow = -1;

    if (lastRow >= 2) {
      const callerCol = sheet.getRange(2, 2, lastRow - 1, 1).getValues(); // column B
      for (let i = 0; i < callerCol.length; i++) {
        if (normalize(callerCol[i][0]) === incomingCaller) {
          matchRow = i + 2; // sheet row (1-indexed, +1 for header)
          break;
        }
      }
    }

    if (matchRow > 0) {
      // Update existing row: refresh timestamp, status, call_sid — keep notes & assigned_to
      sheet.getRange(matchRow, 1).setValue(createdAt);        // A: created_at
      sheet.getRange(matchRow, 3).setValue(tag);               // C: tag
      sheet.getRange(matchRow, 4).setValue("NEW");             // D: status → NEW
      sheet.getRange(matchRow, 7).setValue(callSid);           // G: call_sid
      sheet.getRange(matchRow, 8).setValue(calledNumber);      // H: called_number
      sheet.getRange(matchRow, 9).setValue(digits);            // I: digits

      // Move to row 2 (top of data, right under header) if not already there
      if (matchRow > 2) {
        const rowRange = sheet.getRange(matchRow, 1, 1, 9);
        const rowData = rowRange.getValues();
        sheet.deleteRow(matchRow);
        sheet.insertRowAfter(1);
        sheet.getRange(2, 1, 1, 9).setValues(rowData);
      }

      Logger.log("Updated existing row for caller " + caller + " → moved to top");
    } else {
      // New caller — insert at row 2 (top of data) instead of appending to bottom
      sheet.insertRowAfter(1);
      sheet.getRange(2, 1, 1, 9).setValues([
        [createdAt, caller, tag, "NEW", "", "", callSid, calledNumber, digits]
      ]);
      Logger.log("New callback from " + caller + " → inserted at top");
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * agent_on_call — agent pressed 1 on whisper and joined the conference.
 * Adds a LIVE row to the "Live Calls" sheet.
 */
function handleAgentOnCall(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getOrCreateSheet_(ss, LIVE_CALLS_TAB, LIVE_CALLS_HEADERS);

    const newRow = sheet.getLastRow() + 1;
    const ts = data.timestamp || new Date().toISOString();
    const values = [
      data.agent,
      data.conference_name,
      data.caller_number,
      ts,
      "LIVE",
      "",
      ""
    ];
    sheet.getRange(newRow, 1, 1, values.length).setValues([values]);
    sheet.getRange(newRow, 1).setNumberFormat("@");
    sheet.getRange(newRow, 3).setNumberFormat("@");

    Logger.log("Agent " + data.agent + " is LIVE on " + data.conference_name);
  } finally {
    lock.releaseLock();
  }

  // Trigger push notification via Vercel (fire after sheet write, outside lock)
  try {
    UrlFetchApp.fetch(VERCEL_PUSH_URL, {
      method: "post",
      contentType: "application/json",
      headers: { "x-push-secret": PUSH_SEND_SECRET },
      payload: JSON.stringify({
        agent: data.agent || "",
        caller_number: data.caller_number || "",
        conference_name: data.conference_name || "",
        timestamp: data.timestamp || new Date().toISOString()
      }),
      muteHttpExceptions: true
    });
    Logger.log("Push trigger sent for agent " + data.agent);
  } catch (pushErr) {
    Logger.log("Push trigger failed (non-fatal): " + pushErr);
  }
}

/**
 * agent_call_ended — agent's call leg reached a terminal state.
 *
 * Only "completed" calls get their LIVE row updated to ENDED.
 * Non-completed statuses (no-answer, busy, failed, canceled) mean the agent
 * never actually joined the conference — no LIVE row exists to update.
 *
 * If no matching LIVE row is found for a "completed" call, the agent answered
 * the whisper but didn't press 1 (short call, no agent_on_call was sent).
 * This is a safe no-op.
 */
function handleAgentCallEnded(ss, data) {
  if (data.call_status !== "completed") {
    Logger.log("Ignoring agent_call_ended with status: " + data.call_status +
               " for agent " + data.agent);
    return;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ss.getSheetByName(LIVE_CALLS_TAB);

    if (!sheet) {
      Logger.log("No \"" + LIVE_CALLS_TAB + "\" sheet found. Nothing to update.");
      return;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      Logger.log("Live Calls sheet is empty. Nothing to update.");
      return;
    }

    const dataRange = sheet.getRange(2, 1, lastRow - 1, LIVE_CALLS_HEADERS.length);
    const values = dataRange.getValues();

    // Normalize phone: strip "+" so we match regardless of Sheets formatting
    const normalize = (n) => String(n).trim().replace(/^\+/, "");
    const incomingAgent = normalize(data.agent);

    // Search from bottom (most recent) to top.
    // Match on: Agent Number (col 0) + Conference Name (col 1) + Status "LIVE" (col 4)
    for (let i = values.length - 1; i >= 0; i--) {
      const rowAgent = normalize(values[i][0]);
      const rowConference = String(values[i][1]).trim();
      const rowStatus = String(values[i][4]).trim();

      if (rowAgent === incomingAgent &&
          rowConference === data.conference_name &&
          rowStatus === "LIVE") {

        const sheetRow = i + 2;
        sheet.getRange(sheetRow, 5).setValue("ENDED");
        sheet.getRange(sheetRow, 6).setValue(data.call_duration || "");
        sheet.getRange(sheetRow, 7).setValue(data.timestamp || new Date().toISOString());

        Logger.log("Row " + sheetRow + " → ENDED for agent " + data.agent +
                   " on " + data.conference_name +
                   " (duration: " + data.call_duration + "s)");
        return;
      }
    }

    Logger.log("No LIVE row found for agent " + data.agent +
               " on " + data.conference_name + ". No-op.");
  } finally {
    lock.releaseLock();
  }
}

// ── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Run this manually from the GAS editor (Run → clearStaleLiveCalls)
 * to mark all currently LIVE rows as ENDED.
 */
function clearStaleLiveCalls() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(LIVE_CALLS_TAB);
  if (!sheet) { Logger.log("No Live Calls sheet."); return; }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log("No data rows."); return; }

  const dataRange = sheet.getRange(2, 1, lastRow - 1, LIVE_CALLS_HEADERS.length);
  const values = dataRange.getValues();
  let cleared = 0;

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][4]).trim() === "LIVE") {
      const sheetRow = i + 2;
      sheet.getRange(sheetRow, 5).setValue("ENDED");
      sheet.getRange(sheetRow, 7).setValue(new Date().toISOString());
      cleared++;
    }
  }

  Logger.log("Cleared " + cleared + " stale LIVE rows.");
}

// ── Test Push ─────────────────────────────────────────────────────────────
/**
 * Run this manually: Run → testPushTrigger
 * It calls the Vercel push endpoint directly, same as handleAgentOnCall does.
 * Check the Execution Log below for the result.
 */
function testPushTrigger() {
  Logger.log("Testing push trigger to: " + VERCEL_PUSH_URL);
  Logger.log("Secret: " + PUSH_SEND_SECRET);
  try {
    var resp = UrlFetchApp.fetch(VERCEL_PUSH_URL, {
      method: "post",
      contentType: "application/json",
      headers: { "x-push-secret": PUSH_SEND_SECRET },
      payload: JSON.stringify({
        agent: "+16398403191",
        caller_number: "+18555077602",
        conference_name: "TU_TEST_FROM_GAS",
        timestamp: new Date().toISOString()
      }),
      muteHttpExceptions: true
    });
    Logger.log("Response code: " + resp.getResponseCode());
    Logger.log("Response body: " + resp.getContentText());
  } catch (err) {
    Logger.log("FETCH ERROR: " + err);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the named sheet, creating it with a bold header row if missing.
 */
function getOrCreateSheet_(ss, tabName, headers) {
  let sheet = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    Logger.log("Created sheet: " + tabName);
  }

  return sheet;
}
