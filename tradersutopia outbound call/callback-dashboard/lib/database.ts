const REQUEST_TIMEOUT_MS = 15_000;

type GatewayResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

function gatewayConfig(): { url: string; secret: string } {
  const url = process.env.CALLBACK_DB_API_URL || "";
  const secret = process.env.CALLBACK_DB_API_SECRET || "";
  if (!url || !secret) {
    throw new Error("PostgreSQL database gateway is not configured");
  }
  return { url, secret };
}

export async function databaseRequest<T>(
  action: string,
  payload: object = {}
): Promise<T> {
  const { url, secret } = gatewayConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, payload }),
      cache: "no-store",
      signal: controller.signal,
    });
    const result = (await response.json().catch(() => ({}))) as GatewayResponse<T>;
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Database request failed (${response.status})`);
    }
    return result.data as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("PostgreSQL database request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
