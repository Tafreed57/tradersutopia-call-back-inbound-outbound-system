/**
 * Simple retry with exponential back-off.
 * Retries short-lived database gateway and network failures.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  baseDelayMs = 2000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /timed out|fetch failed|ECONNRESET|429|502|503|504/i.test(msg);
      if (!isTransient || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt); // 2s, 4s
      console.warn(`[retry] Transient failure, waiting ${delay}ms before retry ${attempt + 1}/${maxRetries}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
