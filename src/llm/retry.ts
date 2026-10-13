/**
 * Resilient fetch for LLM API calls: retries transient failures (HTTP 429/5xx
 * and network/timeout errors) with exponential backoff + jitter, and honors a
 * `Retry-After` header when present.
 *
 * Non-retryable responses (e.g. 4xx other than 429) are returned as-is so the
 * caller can surface the error body. The retry budget is exhausted before a
 * thrown network error propagates.
 *
 * Cancellation: a caller-supplied `init.signal` is never retried. It aborts the
 * in-flight request, the body stream and any backoff sleep, and always surfaces
 * as an Error named "AbortError".
 *
 * `timeoutMs` bounds each attempt until the response *headers* arrive. It is
 * deliberately not a total deadline: a streamed completion from a slow local
 * model can legitimately run for minutes, and stalls after the headers are
 * caught by the SSE reader's idle timeout instead.
 */

import { abortError, throwIfAborted } from "./abort.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt time allowed to receive the response headers. */
  timeoutMs?: number;
  /**
   * Longest `Retry-After` we are willing to wait out. A longer hint (e.g. a
   * quota that resets in an hour) means retrying is pointless, so the response
   * is returned and the caller reports the error.
   */
  maxRetryAfterMs?: number;
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
  maxRetryAfterMs: 300_000,
};

type RetryConfig = typeof DEFAULTS;

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const cfg = { ...DEFAULTS, ...options };
  const signal = init.signal ?? undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    throwIfAborted(signal);

    let delay: number;
    let reason: string;

    try {
      const response = await fetchWithHeaderTimeout(url, init, cfg.timeoutMs);

      if (response.ok || !isRetryableStatus(response.status)) {
        return response;
      }

      if (attempt >= cfg.maxAttempts) {
        return response; // out of retries — let the caller read the error body
      }

      const retryAfter = retryAfterMs(response);
      if (retryAfter !== undefined && retryAfter > cfg.maxRetryAfterMs) {
        return response;
      }

      await discardBody(response);
      delay = retryAfter ?? backoffMs(attempt, cfg);
      reason = `HTTP ${response.status}`;
    } catch (error) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      lastError = error;
      if (attempt >= cfg.maxAttempts) {
        break;
      }
      delay = backoffMs(attempt, cfg);
      reason = errorReason(error);
    }

    options.onRetry?.({ attempt, delayMs: delay, reason });
    await sleep(delay, signal);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Request failed after ${cfg.maxAttempts} attempts`);
}

/**
 * The timer is cleared as soon as `fetch` resolves, so it never cuts off a
 * response body that is still streaming. The caller's signal stays attached to
 * the request for its whole lifetime.
 */
async function fetchWithHeaderTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(new DOMException("The operation timed out", "TimeoutError"));
  }, timeoutMs);

  const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Free the socket of a response we are about to retry instead of reading. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: the connection is being abandoned anyway.
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function retryAfterMs(response: Response): number | undefined {
  // OpenAI-style sub-second hint; preferred over the coarser `retry-after`.
  const millisHeader = response.headers.get("retry-after-ms");
  if (millisHeader) {
    const millis = Number(millisHeader);
    if (Number.isFinite(millis)) {
      return Math.max(0, millis);
    }
  }

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

function backoffMs(attempt: number, cfg: RetryConfig): number {
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
