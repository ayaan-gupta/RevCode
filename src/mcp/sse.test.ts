import { describe, expect, it } from "vitest";

import { SseParser, iterateSse } from "./sse.js";

function parseAll(chunks: string[]): ReturnType<SseParser["feed"]> {
  const parser = new SseParser();
  return [...chunks.flatMap((chunk) => parser.feed(chunk)), ...parser.flush()];
}

describe("SseParser", () => {
  it("parses basic events with default type", () => {
    expect(parseAll(["data: hello\n\ndata: world\n\n"])).toEqual([
      { event: "message", data: "hello" },
      { event: "message", data: "world" },
    ]);
  });

  it("handles event names, ids, retry and multi-line data", () => {
    const events = parseAll(["event: endpoint\nid: 7\nretry: 1500\ndata: line1\ndata: line2\n\n"]);
    expect(events).toEqual([{ event: "endpoint", data: "line1\nline2", id: "7", retry: 1500 }]);
  });

  it("is insensitive to chunk boundaries, including mid-CRLF", () => {
    const text = 'event: message\r\ndata: {"a":1}\r\n\r\ndata: second\r\n\r\n';
    const whole = parseAll([text]);
    expect(whole).toHaveLength(2);
    for (let size = 1; size <= 7; size += 1) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      expect(parseAll(chunks)).toEqual(whole);
    }
  });

  it("supports bare CR line endings", () => {
    expect(parseAll(["data: a\r\rdata: b\r\r"])).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "b" },
    ]);
  });

  it("ignores comments, unknown fields and events without data", () => {
    expect(parseAll([": keep-alive\n\nevent: ping\n\nfoo: bar\ndata: x\n\n"])).toEqual([{ event: "message", data: "x" }]);
  });

  it("strips exactly one leading space and a BOM, and allows a field with no colon", () => {
    expect(parseAll(["﻿data:  two spaces\n\ndata\n\n"])).toEqual([
      { event: "message", data: " two spaces" },
      { event: "message", data: "" },
    ]);
  });

  it("persists the last event id across events and ignores invalid retry", () => {
    expect(parseAll(["id: 1\ndata: a\n\ndata: b\n\nretry: soon\ndata: c\n\n"])).toEqual([
      { event: "message", data: "a", id: "1" },
      { event: "message", data: "b", id: "1" },
      { event: "message", data: "c", id: "1" },
    ]);
  });

  it("dispatches a trailing event without a blank line on flush", () => {
    expect(parseAll(["data: last\n"])).toEqual([{ event: "message", data: "last" }]);
    expect(parseAll(["data: last"])).toEqual([{ event: "message", data: "last" }]);
  });
});

describe("iterateSse", () => {
  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"t":"héllo → ✓"}\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    const events = [];
    for await (const event of iterateSse(stream)) events.push(event);
    expect(events).toEqual([{ event: "message", data: '{"t":"héllo → ✓"}' }]);
  });
});
