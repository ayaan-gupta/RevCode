import { describe, expect, it } from "vitest";
import type { LlmMessage } from "../llm/client.js";
import { estimateTokens, forceCompact, maybeCompact } from "./context.js";

function toolMessage(name: string, result: unknown, id = name): LlmMessage {
  return {
    role: "tool",
    toolCallId: id,
    name,
    content: JSON.stringify({ toolCallId: id, name, result }),
  };
}

function bigRead(path: string, id: string): LlmMessage {
  return toolMessage("read_file", { path, totalLines: 400, content: "x".repeat(8000) }, id);
}

describe("estimateTokens", () => {
  it("scales with content length", () => {
    const small = estimateTokens([{ role: "user", content: "hi" }]);
    const large = estimateTokens([{ role: "user", content: "x".repeat(4000) }]);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeCloseTo(1000, -2);
  });
});

describe("maybeCompact", () => {
  it("does nothing below the trigger threshold", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "do something" },
      bigRead("a.txt", "1"),
    ];
    const result = maybeCompact(messages, { tokenLimit: 1_000_000 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });
});

describe("forceCompact", () => {
  function buildLongHistory(): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "build the thing" },
    ];
    // Old reads that should be summarized (far from the tail).
    for (let i = 0; i < 30; i += 1) {
      messages.push(bigRead(`old-${i}.txt`, `r${i}`));
      messages.push({ role: "assistant", content: `step ${i}` });
    }
    return messages;
  }

  it("summarizes old exploratory reads but preserves the system prompt", () => {
    const messages = buildLongHistory();
    const result = forceCompact(messages, { tokenLimit: 1000, keepLastN: 5 });
    expect(result.compacted).toBe(true);
    expect(result.messages[0]).toBe(messages[0]); // system kept
    const summarized = result.messages.filter((m) => m.content.includes('"compacted":true'));
    expect(summarized.length).toBeGreaterThan(0);
  });

  it("keeps a read whose path is referenced again later", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "sys" },
      bigRead("config.yaml", "r1"),
    ];
    for (let i = 0; i < 30; i += 1) {
      messages.push({ role: "assistant", content: "noise" });
    }
    // Reference config.yaml near the end.
    messages.push({ role: "assistant", content: "now editing config.yaml again" });

    const result = forceCompact(messages, { tokenLimit: 1, keepLastN: 2 });
    const readMsg = result.messages.find((m) => m.toolCallId === "r1");
    expect(readMsg?.content).toContain("config.yaml");
    expect(readMsg?.content).not.toContain('"compacted":true');
  });

  it("never compacts error results", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "sys" },
      toolMessage("read_file", { path: "missing.txt", error: "ENOENT" }, "r1"),
    ];
    for (let i = 0; i < 30; i += 1) {
      messages.push({ role: "assistant", content: "noise" });
    }
    const result = forceCompact(messages, { tokenLimit: 1, keepLastN: 2 });
    const readMsg = result.messages.find((m) => m.toolCallId === "r1");
    expect(readMsg?.content).toContain("ENOENT");
  });
});

describe("trimming old payloads", () => {
  it("elides large arguments and old successful shell output outside the recent window, keeping errors", () => {
    const big = "y".repeat(5_000);
    const messages: LlmMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "big.py", content: big } }] },
      { role: "tool", toolCallId: "w1", name: "write_file", content: JSON.stringify({ toolCallId: "w1", name: "write_file", result: { path: "big.py" } }) },
      toolMessage("shell", { stdout: big, exitCode: 0 }, "s1"),
      toolMessage("shell", { stdout: big, exitCode: 2 }, "s2"),
    ];
    for (let i = 0; i < 30; i += 1) messages.push({ role: "assistant", content: "noise" });

    const result = forceCompact(messages, { tokenLimit: 1, keepLastN: 4 });
    const write = result.messages[2];
    expect(JSON.stringify(write.toolCalls)).toContain("chars elided");
    expect(JSON.stringify(write.toolCalls).length).toBeLessThan(800);
    expect(write.toolCalls?.[0].arguments.path).toBe("big.py");

    const ok = result.messages.find((m) => m.toolCallId === "s1");
    expect(ok?.content.length).toBeLessThan(2_000);
    expect(ok?.content).toContain("older output elided");
    const failed = result.messages.find((m) => m.toolCallId === "s2");
    expect(failed?.content.length).toBeGreaterThan(4_000);
  });
});
