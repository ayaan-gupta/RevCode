/**
 * Abort helpers shared by the retry wrapper, the SSE reader and the clients.
 *
 * Callers (the agent loop's interrupt handling) recognise a user cancellation
 * by `error.name === "AbortError"`. `fetch` only produces that name when the
 * signal was aborted without a custom reason, so every layer funnels through
 * `abortError` to make the contract hold regardless of how the signal fired.
 */

export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  const detail =
    reason instanceof Error && reason.name !== "AbortError"
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "";
  const error = new Error(detail ? `Request aborted: ${detail}` : "The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}
