import { describe, expect, it } from "vitest";
import type { LlmMessage } from "./client.js";
import { parseToolArguments, parseToolResultMessage } from "./tool-result.js";

function envelope(result: unknown, extra: Partial<LlmMessage> = {}): LlmMessage {
  return {
    role: "tool",
    content: JSON.stringify({ toolCallId: "c1", name: "shell", result }),
    ...extra,
  };
}

describe("parseToolResultMessage", () => {
  it("renders the envelope's result as plain text with real newlines", () => {
    const parsed = parseToolResultMessage(
      envelope({ stdout: 'line "one"\nline two\n', exitCode: 0 }, { toolCallId: "c1", name: "shell" }),
    );

    expect(parsed.content).toBe('line "one"\nline two\n\n[exit code: 0]');
    expect(parsed.toolCallId).toBe("c1");
    expect(parsed.name).toBe("shell");
    expect(parsed.isError).toBe(false);
  });

  it("takes id and name from the envelope when the message lacks them", () => {
    const parsed = parseToolResultMessage(envelope("done"));

    expect(parsed).toMatchObject({ toolCallId: "c1", name: "shell", content: "done" });
  });

  it("prefers the message's own id and name", () => {
    const parsed = parseToolResultMessage(envelope("x", { toolCallId: "other", name: "renamed" }));

    expect(parsed).toMatchObject({ toolCallId: "other", name: "renamed" });
  });

  it("flags results with a string error field", () => {
    const parsed = parseToolResultMessage(envelope({ error: "boom" }));

    expect(parsed).toMatchObject({ content: "Error: boom", isError: true });
  });

  it("does not flag non-string errors or non-object results", () => {
    expect(parseToolResultMessage(envelope({ error: 1 })).isError).toBe(false);
    expect(parseToolResultMessage(envelope("error")).isError).toBe(false);
    expect(parseToolResultMessage(envelope(null)).isError).toBe(false);
  });

  it("forwards non-envelope content untouched", () => {
    const parsed = parseToolResultMessage({
      role: "tool",
      toolCallId: "c9",
      content: "plain\ntext",
    });

    expect(parsed).toEqual({
      content: "plain\ntext",
      toolCallId: "c9",
      name: undefined,
      isError: false,
    });
  });

  it("forwards JSON without a result key and still detects an error field", () => {
    const content = JSON.stringify({ error: "denied" });
    const parsed = parseToolResultMessage({ role: "tool", toolCallId: "c9", content });

    expect(parsed).toMatchObject({ content, isError: true });
  });

  it("falls back to a placeholder id for an unidentifiable result", () => {
    expect(parseToolResultMessage({ role: "tool", content: "?" }).toolCallId).toBe(
      "unknown-tool-call",
    );
  });
});

describe("parseToolArguments", () => {
  it("parses JSON objects", () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it("treats empty text as no arguments", () => {
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("  \n")).toEqual({});
  });

  it("preserves malformed or non-object JSON under `input`", () => {
    expect(parseToolArguments("{oops")).toEqual({ input: "{oops" });
    expect(parseToolArguments("[1,2]")).toEqual({ input: "[1,2]" });
    expect(parseToolArguments('"str"')).toEqual({ input: '"str"' });
  });
});
