/**
 * Resilient fetch for LLM API calls: retries transient failures (HTTP 429/5xx
 * and network/timeout errors) with exponential backoff + jitter, and honors a
 * `Retry-After` header when present.
 *
 * Non-retryable responses (e.g. 4xx other than 429) are returned as-is so the
 * caller can surface the error body. The retry budget is exhausted before a
 * thrown network error propagates.
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt request timeout. */
  timeoutMs?: number;
  /** Optional hook for logging/telemetry on each retry. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

const DEFAULTS = {
  // Generous budget so transient failures don't abort a whole benchmark task:
  // DNS hiccups right after container startup (ENOTFOUND) and — importantly —
  // provider 429 "service temporarily overloaded" responses, which are common
  // under load and usually clear within a minute. `Retry-After` is honored when
  // present; otherwise exponential backoff spans ~90s before giving up.
  maxAttempts: 8,
  baseDelayMs: 800,
  maxDelayMs: 20_000,
  timeoutMs: 180_000,
};

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const cfg = { ...DEFAULTS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(cfg.timeoutMs),
      });

      if (response.ok || !isRetryableStatus(response.status)) {
        return response;
      }

      if (attempt >= cfg.maxAttempts) {
        return response; // out of retries — let the caller read the error body
      }

      const delay = retryAfterMs(response) ?? backoffMs(attempt, cfg);
      options.onRetry?.({ attempt, delayMs: delay, reason: `HTTP ${response.status}` });
      await sleep(delay);
      continue;
    } catch (error) {
      lastError = error;
      if (attempt >= cfg.maxAttempts) {
        break;
      }
      const delay = backoffMs(attempt, cfg);
      options.onRetry?.({ attempt, delayMs: delay, reason: errorReason(error) });
      await sleep(delay);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Request failed after ${cfg.maxAttempts} attempts`);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

function backoffMs(attempt: number, cfg: typeof DEFAULTS): number {
  const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (attempt - 1));
  const jitter = Math.random() * exp * 0.25;
  return Math.floor(exp + jitter);
}

function errorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "request timeout" : error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
