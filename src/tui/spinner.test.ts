import { describe, expect, it } from "vitest";
import {
  THINKING_STATUS_MESSAGES,
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
