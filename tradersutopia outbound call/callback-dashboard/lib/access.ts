type AccessResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; error: string };

export function normalizeAccessCode(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function validateAccessCode(value: unknown): AccessResult {
  const configured = normalizeAccessCode(process.env.AFFILIATE_ACCESS_CODE);

  if (!configured) {
    return {
      ok: false,
      status: 500,
      error: "Access code is not configured on the server.",
    };
  }

  if (normalizeAccessCode(value) !== configured) {
    return { ok: false, status: 401, error: "Invalid access code" };
  }

  return { ok: true };
}
