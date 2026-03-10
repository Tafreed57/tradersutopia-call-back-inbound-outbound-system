// ─── twilio-callback-bridge/server.js ───
// Minimal outbound bridge: calls the affiliate first, then bridges to the lead.
// Lead sees the Twilio number as caller ID, NOT the affiliate's personal number.

require("dotenv").config({ override: true });

const path = require("path");
const express = require("express");
const twilio = require("twilio");

// ── ENV validation ──────────────────────────────────────────────────────────
const { TWILIO_SID, TWILIO_AUTH, TWILIO_NUMBER } = process.env;

if (!TWILIO_SID || !TWILIO_AUTH || !TWILIO_NUMBER) {
  console.error(
    "FATAL: Missing one or more required env vars: TWILIO_SID, TWILIO_AUTH, TWILIO_NUMBER"
  );
  console.error("Copy .env.example → .env and fill in your Twilio credentials.");
  process.exit(1);
}

// ── Twilio client ───────────────────────────────────────────────────────────
const client = twilio(TWILIO_SID, TWILIO_AUTH);

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json()); // parse JSON bodies (for /start-call)
app.use(express.urlencoded({ extended: false })); // parse Twilio webhook POSTs
app.use(express.static(path.join(__dirname, "public"))); // serve frontend

// ── Helpers ─────────────────────────────────────────────────────────────────
function redact(phone) {
  // "+15551234567" → "+1555***4567"
  if (!phone || phone.length < 8) return phone;
  return phone.slice(0, 5) + "***" + phone.slice(-4);
}

function isE164(val) {
  return typeof val === "string" && /^\+[1-9]\d{6,14}$/.test(val);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /start-call
// Body: { agentNumber, leadNumber, publicBaseUrl }
//
// 1. Calls the affiliate (agentNumber) FROM the Twilio number.
// 2. When the affiliate picks up, Twilio fetches /bridge?lead=<leadNumber>
//    which returns TwiML to bridge to the lead.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/start-call", async (req, res) => {
  console.log("\n── /start-call hit ──");

  const { agentNumber, leadNumber, publicBaseUrl } = req.body || {};

  // ── Validate ──
  if (!agentNumber || !leadNumber || !publicBaseUrl) {
    console.warn("  ✗ Missing required fields");
    return res.status(400).json({
      ok: false,
      error:
        "Missing required fields. Send JSON: { agentNumber, leadNumber, publicBaseUrl }",
    });
  }

  if (!isE164(agentNumber)) {
    console.warn(`  ✗ agentNumber is not valid E.164: ${agentNumber}`);
    return res.status(400).json({
      ok: false,
      error:
        'agentNumber must be E.164 format (e.g. "+15551234567"). Include country code with leading "+".',
    });
  }

  if (!isE164(leadNumber)) {
    console.warn(`  ✗ leadNumber is not valid E.164: ${leadNumber}`);
    return res.status(400).json({
      ok: false,
      error:
        'leadNumber must be E.164 format (e.g. "+15551234567"). Include country code with leading "+".',
    });
  }

  console.log(`  Agent : ${redact(agentNumber)}`);
  console.log(`  Lead  : ${redact(leadNumber)}`);
  console.log(`  Base  : ${publicBaseUrl}`);

  // Build the webhook URL Twilio will fetch when the agent picks up
  const bridgeUrl = `${publicBaseUrl}/bridge?lead=${encodeURIComponent(leadNumber)}`;
  console.log(`  Bridge URL: ${bridgeUrl}`);

  try {
    const call = await client.calls.create({
      to: agentNumber, // ring the affiliate first
      from: TWILIO_NUMBER, // caller ID on affiliate's phone
      url: bridgeUrl, // Twilio fetches this when affiliate answers
      method: "POST",
    });

    console.log(`  ✓ Call created — SID: ${call.sid}`);
    return res.json({ ok: true, callSid: call.sid });
  } catch (err) {
    console.error("  ✗ Twilio API error:", err.message);
    console.error("    Status:", err.status || "N/A");
    console.error("    Code:", err.code || "N/A");
    console.error("    More info:", err.moreInfo || "N/A");
    return res.status(500).json({
      ok: false,
      error: err.message,
      twilioCode: err.code || null,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bridge?lead=<E.164 number>
//
// Twilio calls this webhook when the affiliate answers.
// Returns TwiML: whisper message → <Dial> to lead with Twilio caller ID.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/bridge", (req, res) => {
  const leadNumber = req.query.lead;
  console.log(`\n── /bridge hit ── lead=${redact(leadNumber)}`);

  if (!leadNumber || !isE164(leadNumber)) {
    console.warn("  ✗ Missing or invalid lead number in query string");
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, something went wrong. The lead number is missing.");
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const twiml = new twilio.twiml.VoiceResponse();

  // Short whisper so the affiliate knows this is a callback bridge
  twiml.say(
    { voice: "alice", language: "en-US" },
    "Connecting you to your callback."
  );

  // Dial the lead — lead sees TWILIO_NUMBER as caller ID
  const dial = twiml.dial({ callerId: TWILIO_NUMBER });
  dial.number(leadNumber);

  console.log(`  ✓ TwiML sent — dialing lead ${redact(leadNumber)}`);

  res.type("text/xml");
  return res.send(twiml.toString());
});

// ── Health check ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    service: "twilio-callback-bridge",
    status: "running",
    twilioNumber: TWILIO_NUMBER,
  });
});

// ── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 twilio-callback-bridge listening on http://localhost:${PORT}`);
  console.log(`   Twilio number: ${TWILIO_NUMBER}`);
  console.log(`   Endpoints:`);
  console.log(`     POST /start-call  — trigger an outbound bridge call`);
  console.log(`     POST /bridge      — Twilio webhook (returns TwiML)`);
  console.log(`     GET  /            — affiliate dialer UI`);
  console.log(`     GET  /health      — health check\n`);
});
