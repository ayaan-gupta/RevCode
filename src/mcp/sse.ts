/**
 * Minimal Server-Sent Events parser (WHATWG HTML "event stream" format).
 *
 * Both MCP HTTP transports speak SSE: Streamable HTTP may answer a POST with
 * `text/event-stream`, and the legacy transport is SSE end to end. This is a
 * local implementation (no dependency, no shared code outside `src/mcp`)
 * covering exactly what those transports need.
 *
 * Design notes:
 * - Incremental: `feed()` accepts arbitrary chunk boundaries, including a
 *   split inside a line, inside a field, or between the `\r` and `\n` of a
 *   CRLF pair. Network chunking must never change what the parser emits.
 * - Lenient at EOF: the spec says an unterminated final event is discarded,
 *   but servers that close the connection right after `data: {...}` (no blank
 *   line) do exist, and dropping their last response would hang the request.
 *   `flush()` therefore dispatches a pending event that has data.
 */

export interface SseEvent {
  /** Event type; `message` when the stream did not name one. */
  event: string;
  /** Data lines joined with `\n`. */
  data: string;
  /** Last event ID seen on the stream so far (persists across events, per spec). */
  id?: string;
  /** Reconnection delay requested by the server, in ms. */
  retry?: number;
}

export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventType = "";
  private lastEventId: string | undefined;
  private retry: number | undefined;
  private atStart = true;
  /** Where the next terminator scan resumes, so one huge line is not rescanned per chunk. */
  private scanFrom = 0;

  /** Consume a decoded text chunk; returns every event completed by it. */
  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    if (this.atStart && this.buffer.length > 0) {
      if (this.buffer.charCodeAt(0) === 0xfeff) {
        this.buffer = this.buffer.slice(1);
      }
      this.atStart = this.buffer.length === 0;
    }

    const events: SseEvent[] = [];
    let start = 0;
    let scan = this.scanFrom;
    for (;;) {
      const end = this.findLineEnd(scan);
      if (end === undefined) {
        break;
      }
      const line = this.buffer.slice(start, end.index);
      start = end.next;
      scan = start;
      const event = this.processLine(line);
      if (event) {
        events.push(event);
      }
    }
    this.buffer = this.buffer.slice(start);
    // Re-check the final char next time: it may be a held-back `\r`.
    this.scanFrom = Math.max(0, this.buffer.length - 1);
    return events;
  }

  /** Signal end of stream; dispatches a trailing event that has data. */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const event = this.processLine(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
      this.scanFrom = 0;
      if (event) {
        events.push(event);
      }
    }
    const last = this.dispatch();
    if (last) {
      events.push(last);
    }
    return events;
  }

  /**
   * Locate the next line terminator at or after `from`. A trailing `\r` at the
   * very end of the buffer is held back: it may be the first half of `\r\n`.
   */
  private findLineEnd(from: number): { index: number; next: number } | undefined {
    for (let i = from; i < this.buffer.length; i += 1) {
      const ch = this.buffer.charCodeAt(i);
      if (ch === 0x0a) {
        return { index: i, next: i + 1 };
      }
      if (ch === 0x0d) {
        if (i + 1 >= this.buffer.length) {
          return undefined;
        }
        return { index: i, next: this.buffer.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1 };
      }
    }
    return undefined;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === "") {
      return this.dispatch();
    }
    if (line.startsWith(":")) {
      return undefined; // comment / keep-alive
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) {
          this.lastEventId = value;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) {
          this.retry = Number(value);
        }
        break;
      default:
        break; // unknown fields are ignored
    }
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    const hadData = this.dataLines.length > 0;
    const event: SseEvent | undefined = hadData
      ? {
          event: this.eventType === "" ? "message" : this.eventType,
          data: this.dataLines.join("\n"),
          ...(this.lastEventId !== undefined ? { id: this.lastEventId } : {}),
          ...(this.retry !== undefined ? { retry: this.retry } : {}),
        }
      : undefined;
    this.dataLines = [];
    this.eventType = "";
    return event;
  }
}

/**
 * Iterate the events of an SSE response body until it ends or errors.
 * The reader is cancelled if the consumer stops early (e.g. `break`).
 */
export async function* iterateSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
        yield event;
      }
    }
    for (const event of parser.feed(decoder.decode())) {
      yield event;
    }
    for (const event of parser.flush()) {
      yield event;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
