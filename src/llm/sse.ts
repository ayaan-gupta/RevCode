/**
 * Server-Sent Events reader shared by the OpenAI-compatible and Anthropic
 * clients.
 *
 * Follows the WHATWG parsing rules (LF/CRLF/CR line endings, `:` comments,
 * multi-line `data`, one leading space stripped from values) and tolerates the
 * ways real servers deviate: frames split at arbitrary byte boundaries
 * (including inside a multi-byte character or between the CR and LF of a line
 * ending), and a final frame that is never terminated by a blank line.
 *
 * The OpenAI-style `[DONE]` sentinel ends the stream and is not yielded.
 */

import { abortError } from "./abort.js";

export interface SseEvent {
  /** Value of the `event:` field, when the frame carried one. */
  event?: string;
  /** All `data:` lines of the frame joined with "\n". */
  data: string;
}

export interface ReadSseOptions {
  /** Abort reading (and cancel the underlying body) when fired. */
  signal?: AbortSignal;
  /**
   * Fail if no bytes arrive for this long. Providers send keep-alives/pings, so
   * a longer silence means the connection is stalled rather than thinking.
   */
  idleTimeoutMs?: number;
}

export const SSE_DONE = "[DONE]";

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  options: ReadSseOptions = {},
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frame = new FrameBuilder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await readChunk(reader, options);
      buffer += decoder.decode(value, { stream: !done });

      const consumed = consumeLines(buffer, done, (line) => frame.push(line));
      buffer = buffer.slice(consumed);

      for (const event of frame.take()) {
        if (event.data === SSE_DONE) {
          return;
        }
        yield event;
      }

      if (done) {
        break;
      }
    }

    const trailing = frame.flush();
    if (trailing && trailing.data !== SSE_DONE) {
      yield trailing;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Feeds complete lines to `onLine` and returns how many characters were used.
 * A trailing CR is held back until more input arrives because it may be the
 * first half of a CRLF split across chunks.
 */
function consumeLines(buffer: string, final: boolean, onLine: (line: string) => void): number {
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const char = buffer[i];
    if (char === "\n") {
      onLine(buffer.slice(start, i));
      start = i + 1;
    } else if (char === "\r") {
      if (i + 1 >= buffer.length && !final) {
        break;
      }
      onLine(buffer.slice(start, i));
      if (buffer[i + 1] === "\n") {
        i += 1;
      }
      start = i + 1;
    }
  }

  if (final && start < buffer.length) {
    onLine(buffer.slice(start));
    return buffer.length;
  }
  return start;
}

class FrameBuilder {
  private event: string | undefined;
  private data: string[] = [];
  private ready: SseEvent[] = [];

  push(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) {
      return; // comment / keep-alive
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "data") {
      this.data.push(value);
    } else if (field === "event") {
      this.event = value;
    }
    // `id` and `retry` carry reconnection state we never use.
  }

  /** Frames completed by the lines pushed since the last call. */
  take(): SseEvent[] {
    const events = this.ready;
    this.ready = [];
    return events;
  }

  /** Emit a final frame that the server never terminated with a blank line. */
  flush(): SseEvent | undefined {
    this.dispatch();
    return this.take()[0];
  }

  private dispatch(): void {
    if (this.data.length > 0) {
      const event: SseEvent = { data: this.data.join("\n") };
      if (this.event) {
        event.event = this.event;
      }
      this.ready.push(event);
    }
    this.event = undefined;
    this.data = [];
  }
}

/** One read, raced against the abort signal and the idle timeout. */
function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  { signal, idleTimeoutMs }: ReadSseOptions,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (idleTimeoutMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        const error = new Error(`Stream stalled: no data received for ${idleTimeoutMs}ms`);
        error.name = "TimeoutError";
        reject(error);
      }, idleTimeoutMs);
    }

    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
