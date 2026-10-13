import { describe, expect, it } from "vitest";
import { type SseEvent, readSse } from "./sse.js";
import { byteStream } from "./test-helpers.js";

async function collect(
  chunks: Array<string | Uint8Array>,
  options?: Parameters<typeof readSse>[1],
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of readSse(byteStream(chunks), options)) {
    events.push(event);
  }
  return events;
}

describe("readSse", () => {
  it("yields data frames and event names", async () => {
    const events = await collect(["event: ping\ndata: 1\n\ndata: 2\n\n"]);
    expect(events).toEqual([{ event: "ping", data: "1" }, { data: "2" }]);
  });

  it("handles CRLF and bare CR line endings", async () => {
    expect(await collect(["data: a\r\n\r\ndata: b\r\r"])).toEqual([{ data: "a" }, { data: "b" }]);
  });

  it("joins multi-line data with newlines", async () => {
    expect(await collect(["data: one\ndata: two\ndata:three\n\n"])).toEqual([
      { data: "one\ntwo\nthree" },
    ]);
  });

  it("ignores comments, unknown fields and blank-only frames", async () => {
    const events = await collect([
      ": OPENROUTER PROCESSING\n\n",
      "id: 7\nretry: 100\nfoo: bar\ndata: x\n\n",
      "\n\n",
    ]);
    expect(events).toEqual([{ data: "x" }]);
  });

  it("reassembles frames split across reads, even mid-field", async () => {
    const events = await collect(["da", "ta: hel", "lo\n", "\nda", "ta: wor", "ld\n\n"]);
    expect(events).toEqual([{ data: "hello" }, { data: "world" }]);
  });

  it("does not treat a CR/LF pair split across reads as two line endings", async () => {
    // "\r" then "\n" must be one terminator; otherwise an extra blank line
    // would dispatch the frame early and split a multi-line payload.
    const events = await collect(["data: a\r", "\ndata: b\r", "\n\r", "\n"]);
    expect(events).toEqual([{ data: "a\nb" }]);
  });

  it("decodes a multi-byte character split across reads", async () => {
    const bytes = new TextEncoder().encode("data: héllo €\n\n");
    const euro = bytes.indexOf(0xe2); // first byte of the 3-byte euro sign
    const events = await collect([bytes.slice(0, euro + 1), bytes.slice(euro + 1)]);
    expect(events).toEqual([{ data: "héllo €" }]);
  });

  it("stops at [DONE] without yielding it", async () => {
    const events = await collect(["data: a\n\ndata: [DONE]\n\ndata: ignored\n\n"]);
    expect(events).toEqual([{ data: "a" }]);
  });

  it("flushes a final frame the server never terminated", async () => {
    expect(await collect(["data: a\n\ndata: tail"])).toEqual([{ data: "a" }, { data: "tail" }]);
  });

  it("does not yield an unterminated trailing [DONE]", async () => {
    expect(await collect(["data: a\n\ndata: [DONE]"])).toEqual([{ data: "a" }]);
  });

  it("propagates stream errors after delivering earlier frames", async () => {
    const stream = byteStream(["data: a\n\n"], { failWith: new Error("socket hang up") });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const event of readSse(stream)) {
          seen.push(event.data);
        }
      })(),
    ).rejects.toThrow("socket hang up");
    expect(seen).toEqual(["a"]);
  });

  it("rejects with AbortError when the signal fires while waiting for data", async () => {
    const controller = new AbortController();
    const stream = byteStream(["data: a\n\n"], { hang: true });
    const seen: string[] = [];

    const reading = (async () => {
      for await (const event of readSse(stream, { signal: controller.signal })) {
        seen.push(event.data);
        controller.abort();
      }
    })();

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["a"]);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect(["data: a\n\n"], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("fails a stalled stream after the idle timeout", async () => {
    const stream = byteStream([], { hang: true });
    await expect(
      (async () => {
        for await (const event of readSse(stream, { idleTimeoutMs: 20 })) {
          void event;
        }
      })(),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
