/**
 * Block emergency and special service numbers from being dialed.
 * Used for manual dial and lead calls.
 */

// Normalize to digits only (no + or spaces)
function toDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

// E.164: 7–15 digits after optional leading 1 (US country code)
const E164_DIGITS = /^\+?1?(\d{10,14})$/;

/**
 * Returns true if the number is a known emergency or N11/special number.
 * Call this before initiating any outbound call.
 */
export function isEmergencyNumber(phone: string): boolean {
  const digits = toDigits(phone);
  if (!digits.length) return true;

  // Exact match list (with and without US country code 1)
  const blocked = new Set([
    "911", "1911",
    "112", "1112",
    "999", "1999",
    "000", "1000",
    "111", "1111",
    "110", "1110",
    "119", "1119",
    "100", "1100",
    "102", "1102",
    "108", "1108",
    "211", "1211",
    "311", "1311",
    "411", "1411",
    "511", "1511",
    "611", "1611",
    "711", "1711",
    "811", "1811",
  ]);

  if (blocked.has(digits)) return true;
  // Without leading 1 (e.g. 911)
  if (digits.startsWith("1") && blocked.has(digits.slice(1))) return true;
  return false;
}
