import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THINKING_STATUS_MESSAGES,
  ThinkingSpinner,
  pickThinkingStatusMessage,
} from "./spinner.js";

describe("pickThinkingStatusMessage", () => {
  it("returns a message from the pool", () => {
    const message = pickThinkingStatusMessage();
    expect(THINKING_STATUS_MESSAGES).toContain(message);
  });

  it("selects deterministically from a mocked random value", () => {
    const index = 7;
    const message = pickThinkingStatusMessage(
      () => index / THINKING_STATUS_MESSAGES.length,
    );
    expect(message).toBe(THINKING_STATUS_MESSAGES[index]);
  });

  it("wraps to the last message when random is just below 1", () => {
    const message = pickThinkingStatusMessage(() => 0.999999);
    expect(message).toBe(
      THINKING_STATUS_MESSAGES[THINKING_STATUS_MESSAGES.length - 1],
    );
  });

  it("keeps a varied pool of playful status words", () => {
    expect(THINKING_STATUS_MESSAGES.length).toBeGreaterThanOrEqual(15);
    expect(THINKING_STATUS_MESSAGES.length).toBeLessThanOrEqual(25);

    for (const message of THINKING_STATUS_MESSAGES) {
      expect(message.endsWith("…")).toBe(true);
      expect(message.length).toBeGreaterThan(2);
      expect(message[0]).toBe(message[0]!.toUpperCase());
    }
  });
});

describe("ThinkingSpinner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps one capitalized status message during rich mode ticks", () => {
    const spinner = new ThinkingSpinner(true);
    const handle = spinner.start();

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(80);
    }

    handle.stop();

    const rendered = vi
      .mocked(process.stdout.write)
      .mock.calls.map(([chunk]) => String(chunk));
    expect(rendered.some((line) => line.includes("Brewing…"))).toBe(true);
    expect(rendered.some((line) => line.includes("Calibrating…"))).toBe(false);
    expect(rendered.at(-1)).toBe("\r\x1b[K");
  });

  it("writes one plain mode status message without rotation", () => {
    const spinner = new ThinkingSpinner(false);
    const handle = spinner.start();

    expect(process.stdout.write).toHaveBeenCalledWith("Brewing…");

    vi.advanceTimersByTime(800);

    const rendered = vi
      .mocked(process.stdout.write)
      .mock.calls.map(([chunk]) => String(chunk));
    expect(rendered.filter((line) => line === "Brewing…").length).toBe(1);
    expect(rendered.some((line) => line.includes("Calibrating…"))).toBe(false);

    handle.stop();
  });
});
