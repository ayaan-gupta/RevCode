import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./retry.js";

const FAST = { baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 1000 } as const;

function jsonResponse(status: number, body = "{}"): Response {
  return new Response(body, { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchWithRetry", () => {
  it("returns immediately on success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("http://x", {}, FAST);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 503 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("http://x", {}, FAST);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("http://x", {}, FAST);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-retryable 400", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, "bad"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("http://x", {}, FAST);
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries thrown network errors then propagates after exhaustion", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithRetry("http://x", {}, { ...FAST, maxAttempts: 3 })).rejects.toThrow(
      "ECONNRESET",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns the last error response after exhausting retries", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("http://x", {}, { ...FAST, maxAttempts: 2 });
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchWithRetry cancellation", () => {
  it("rejects with AbortError without calling fetch when already aborted", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchWithRetry("http://x", { signal: controller.signal }, FAST),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry when the signal aborts an in-flight request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          setTimeout(() => controller.abort(), 5);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("http://x", { signal: controller.signal }, { ...FAST, maxAttempts: 5 }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalises an abort with a custom reason to AbortError", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            controller.abort(new Error("user pressed escape"));
          }),
      ),
    );

    const error = await fetchWithRetry("http://x", { signal: controller.signal }, FAST).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: "AbortError" });
    expect((error as Error).message).toContain("user pressed escape");
  });

  it("aborts promptly during a backoff sleep", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => jsonResponse(503));
    vi.stubGlobal("fetch", fetchMock);
    setTimeout(() => controller.abort(), 20);

    const started = Date.now();
    await expect(
      fetchWithRetry(
        "http://x",
        { signal: controller.signal },
        { baseDelayMs: 30_000, maxDelayMs: 30_000, timeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithRetry timing", () => {
  it("waits for Retry-After instead of the computed backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "0.05" } }))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();

    const res = await fetchWithRetry(
      "http://x",
      {},
      { baseDelayMs: 5000, maxDelayMs: 5000, timeoutMs: 1000, onRetry },
    );

    expect(res.status).toBe(200);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 50, reason: "HTTP 429" }));
  });

  it("prefers the millisecond retry-after-ms header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", {
          status: 429,
          headers: { "retry-after": "30", "retry-after-ms": "7" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();

    await fetchWithRetry("http://x", {}, { ...FAST, onRetry });
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 7 }));
  });

  it("returns the response instead of waiting out an excessive Retry-After", async () => {
    const fetchMock = vi.fn(
      async () => new Response("quota", { status: 429, headers: { "retry-after": "3600" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("http://x", {}, { ...FAST, maxRetryAfterMs: 1000 });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("quota");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a request that times out before the headers arrive", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      )
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("http://x", {}, { ...FAST, timeoutMs: 20 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not apply the timeout to a body that is still streaming", async () => {
    const encoder = new TextEncoder();
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode("late"));
          controller.close();
        }, 80);
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(slowBody)));

    const res = await fetchWithRetry("http://x", {}, { ...FAST, timeoutMs: 20 });
    expect(await res.text()).toBe("late");
  });
});


describe("describeNetworkError", () => {
  it("surfaces the cause hidden behind Node's generic 'fetch failed'", async () => {
    const { describeNetworkError } = await import("./retry.js");
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" });
    const error = new TypeError("fetch failed", { cause });
    expect(describeNetworkError(error)).toContain("ENOTFOUND");
    expect(describeNetworkError(error)).toContain("api.example.com");
    expect(describeNetworkError(new Error("plain"))).toBe("plain");
  });
});
