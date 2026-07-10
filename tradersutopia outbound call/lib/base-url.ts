/**
 * Determine the public base URL for Twilio webhooks.
 *
 * On Vercel, prefer the request host so a stale PUBLIC_BASE_URL cannot send
 * Twilio to an old ngrok or preview URL. Outside Vercel, PUBLIC_BASE_URL still
 * works as the local ngrok override.
 */
export function getPublicBaseUrl(hostHeader: string | null): string {
  const hostUrl = hostHeader ? hostToUrl(hostHeader) : "";

  if (process.env.VERCEL && hostUrl && !isLocalBaseUrl(hostUrl)) {
    return hostUrl;
  }

  const publicBaseUrl = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || "");
  if (publicBaseUrl) return publicBaseUrl;

  const vercelUrl = normalizeBaseUrl(process.env.VERCEL_URL || "");
  if (vercelUrl) return vercelUrl;

  return hostUrl;
}

export function isLocalBaseUrl(value: string): boolean {
  return /(^https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(value);
}

function hostToUrl(hostHeader: string): string {
  const host = hostHeader.trim();
  if (!host) return "";

  const proto = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/i.test(host)
    ? "http"
    : "https";

  return `${proto}://${host}`.replace(/\/+$/, "");
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}
