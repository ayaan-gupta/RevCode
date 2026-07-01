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
