/**
 * Network-free fixtures for the provider client tests: hand-built SSE
 * streams and a recording `fetch` stub.
 */

import { vi } from "vitest";

const encoder = new TextEncoder();

export interface StreamOptions {
  /** Error the stream after the chunks (simulates a dropped connection). */
  failWith?: Error;
  /** Leave the stream open after the chunks (simulates a stalled server). */
  hang?: boolean;
}

/** One `Uint8Array` per entry, so tests control exactly where reads split. */
export function byteStream(
  chunks: Array<string | Uint8Array>,
  options: StreamOptions = {},
): ReadableStream<Uint8Array> {
  // Chunks are handed out one per pull: erroring a stream discards anything
  // still queued, which would hide the frames that preceded the failure.
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) {
        const chunk = chunks[next];
        next += 1;
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      } else if (options.failWith) {
        controller.error(options.failWith);
      } else if (options.hang) {
        return new Promise<void>(() => undefined);
      } else {
        controller.close();
      }
      return undefined;
    },
  });
}

export function sseResponse(
  chunks: Array<string | Uint8Array>,
  options: StreamOptions & { status?: number } = {},
): Response {
  return new Response(byteStream(chunks, options), {
    status: options.status ?? 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** `data: <json>` frames (one per object), terminated like a real server. */
export function dataFrames(...payloads: unknown[]): string[] {
  return payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`);
}

/** Anthropic-style frames: `event: <type>` + `data: <json>`. */
export function eventFrames(...events: Array<{ type: string } & Record<string, unknown>>): string[] {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface RecordedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
}

/**
 * Replaces `globalThis.fetch` and records each request. `respond` may be a
 * single response factory or a queue consumed one call at a time.
 */
export function stubFetch(
  respond: (() => Response | Promise<Response>) | Array<() => Response | Promise<Response>>,
): { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const queue = Array.isArray(respond) ? [...respond] : undefined;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      requests.push({
        url: String(url),
        method: init?.method,
        headers: normalizeHeaders(init?.headers),
        body: JSON.parse(rawBody) as Record<string, unknown>,
        signal: init?.signal,
      });
      const next = queue ? queue.shift() : respond;
      if (typeof next !== "function") {
        throw new Error("stubFetch: no response queued");
      }
      return next();
    }),
  );

  return { requests };
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}
