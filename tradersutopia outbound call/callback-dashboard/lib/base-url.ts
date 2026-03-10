/**
 * Determine the public base URL for Twilio webhooks.
 *
 * Priority:
 *  1. PUBLIC_BASE_URL env var (manual override — used for ngrok in local dev)
 *  2. VERCEL_URL env var (set automatically by Vercel)
 *  3. Host header from the incoming request
 */
export function getPublicBaseUrl(hostHeader: string | null): string {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.trim();
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  if (hostHeader) {
    const proto = hostHeader.includes("localhost") ? "http" : "https";
    return `${proto}://${hostHeader}`;
  }

  return "";
}
