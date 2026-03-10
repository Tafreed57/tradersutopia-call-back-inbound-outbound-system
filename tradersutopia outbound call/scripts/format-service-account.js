/**
 * Reads your downloaded Google service account JSON file
 * and prints it as ONE LINE so you can paste into .env.local
 *
 * Usage:
 *   node scripts/format-service-account.js
 *   node scripts/format-service-account.js path/to/your-key.json
 *
 * Then in .env.local add:
 *   GOOGLE_SERVICE_ACCOUNT_JSON=<paste the line below>
 */

const fs = require("fs");
const path = require("path");

const possibleNames = [
  "service-account.json",
  "callback-dashboard.json",
  "key.json",
  "credentials.json",
];

const filePath = process.argv[2] || (() => {
  for (const name of possibleNames) {
    const p = path.join(__dirname, "..", name);
    if (fs.existsSync(p)) return p;
  }
  return null;
})();

if (!filePath || !fs.existsSync(filePath)) {
  console.error("Usage: node scripts/format-service-account.js [path-to-json-file]");
  console.error("");
  console.error("No JSON file found. Either:");
  console.error("  1. Put your downloaded key in the project folder and name it service-account.json");
  console.error("  2. Or run: node scripts/format-service-account.js C:\\path\\to\\your-key.json");
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(filePath, "utf8");
} catch (e) {
  console.error("Could not read file:", filePath, e.message);
  process.exit(1);
}

// Validate it's valid JSON and has required fields
let obj;
try {
  obj = JSON.parse(raw);
} catch (e) {
  console.error("File is not valid JSON:", e.message);
  process.exit(1);
}

if (obj.type !== "service_account" || !obj.client_email) {
  console.error("File doesn't look like a Google service account JSON (missing type or client_email).");
  process.exit(1);
}

const oneLine = JSON.stringify(obj);
console.log("");
console.log("Copy the line below into .env.local as the value for GOOGLE_SERVICE_ACCOUNT_JSON:");
console.log("");
console.log(oneLine);
console.log("");
console.log("Your service account email (share your Sheet with this):", obj.client_email);
console.log("");
