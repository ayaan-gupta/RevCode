/**
 * Limits shared by all provider clients.
 */

// Reasoning models split completion tokens between chain-of-thought and the
// answer (glm-5.2 `reasoning_content`, Claude adaptive thinking). A low cap
// starves the answer (finish reason "length"), so default to a generous budget.
export const DEFAULT_MAX_TOKENS = 16_384;

/** Per-attempt time allowed to receive response headers (see retry.ts). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

// Longer than the header timeout: a silent gap mid-stream is normal while a
// reasoning model thinks without emitting tokens, but not forever.
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export interface TimeoutConfig {
  /** Overrides both the header timeout and the stream idle timeout. */
  timeoutMs?: number;
}

export function requestTimeoutMs(config: TimeoutConfig): number {
  return config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

export function streamIdleTimeoutMs(config: TimeoutConfig): number {
  return config.timeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/** A positive integer override, or the default when absent/invalid. */
export function resolveMaxTokens(requested: number | undefined): number {
  return requested !== undefined && Number.isFinite(requested) && requested >= 1
    ? Math.floor(requested)
    : DEFAULT_MAX_TOKENS;
}
