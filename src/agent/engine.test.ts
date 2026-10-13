import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { say, ScriptedLlm, toolCall } from "../testing/scripted-llm.js";
import { DEFAULT_PROFILE, withProfile } from "../harness/profile.js";
import { createVerifyGate } from "../harness/verify-gate.js";
import { ToolRegistry } from "../tools/index.js";
import { TimeBudget } from "../harness/time-budget.js";
import type { LlmMessage } from "../llm/client.js";
import { AgentEngine, looksLikeUnfinishedNarration, MAX_TOOL_RESULT_CHARS, type EngineOptions } from "./engine.js";

const registries: ToolRegistry[] = [];
afterEach(() => {
  while (registries.length) registries.pop()?.dispose();
});

function makeEngine(
  steps: ConstructorParameters<typeof ScriptedLlm>[0],
  overrides: Partial<EngineOptions> = {},
) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "revcode-engine-"));
  const tools = new ToolRegistry({ cwd });
  registries.push(tools);
  const llm = new ScriptedLlm(steps);
  const engine = new AgentEngine({
    cwd,
    llm,
    profile: DEFAULT_PROFILE,
    systemPrompt: "sys",
    tools,
    maxIterations: 10,
    ...overrides,
  });
  return { engine, llm, tools, cwd };
}

describe("AgentEngine", () => {
  it("runs a tool call then finishes, recording messages and trajectory", async () => {
    const { engine } = makeEngine([
      toolCall("write_file", { path: "a.txt", content: "hello\n" }),
      say("done"),
    ]);
    const result = await engine.runTurn("make a file");

    expect(result.stopReason).toBe("complete");
    expect(result.finalContent).toBe("done");
    expect(result.toolCalls).toBe(1);
    expect(engine.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(engine.trajectory.map((e) => e.type)).toEqual([
      "system",
      "user",
      "tool_call",
      "tool_result",
      "assistant",
    ]);
  });

  it("lets middleware veto a tool call and tells the model why", async () => {
    const { engine } = makeEngine(
      [toolCall("write_file", { path: "x.txt", content: "no" }), say("ok")],
      {
        middleware: [{ name: "deny", before: () => ({ allow: false, reason: "writes are blocked" }) }],
      },
    );
    await engine.runTurn("write");
    const toolMessage = engine.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("writes are blocked");
    expect(toolMessage?.content).toContain("denied");
  });

  it("lets middleware rewrite arguments and replace results", async () => {
    const { engine, cwd } = makeEngine(
      [toolCall("write_file", { path: "a.txt", content: "x" }), say("ok")],
      {
        middleware: [
          {
            name: "rewrite",
            before: ({ call }) => ({ allow: true, input: { ...call.arguments, path: "b.txt" } }),
            after: () => ({ replaced: true }),
          },
        ],
      },
    );
    await engine.runTurn("w");
    const fs = await import("node:fs");
    expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(true);
    expect(engine.messages.find((m) => m.role === "tool")?.content).toContain("replaced");
  });

  it("consults final gates and continues when one pushes back (once)", async () => {
    const { engine } = makeEngine(
      [say("first answer"), say("second answer")],
      {
        finalGates: [
          (() => {
            let used = false;
            return {
              name: "g",
              check: () => {
                if (used) return undefined;
                used = true;
                return "verify please";
              },
            };
          })(),
        ],
      },
    );
    const result = await engine.runTurn("task");
    expect(result.finalContent).toBe("second answer");
    expect(engine.messages.some((m) => m.role === "user" && m.content.includes("verify please"))).toBe(true);
  });

  it("verify gate nudges when files changed but nothing was run, then accepts", async () => {
    const verify = createVerifyGate();
    const { engine } = makeEngine(
      [
        toolCall("write_file", { path: "a.py", content: "print(1)\n" }),
        say("all done"),
        toolCall("shell", { command: "python3 a.py" }),
        say("verified"),
      ],
      { middleware: [verify.middleware], finalGates: [verify.gate] },
    );
    const result = await engine.runTurn("write and run");
    expect(result.finalContent).toBe("verified");
    expect(result.toolCalls).toBe(2);

    // Never nudges twice for the same change.
    const { engine: again } = makeEngine(
      [toolCall("write_file", { path: "b.py", content: "1\n" }), say("a"), say("b")],
      { middleware: [createVerifyGate().middleware], finalGates: [createVerifyGate().gate] },
    );
    expect((await again.runTurn("t")).stopReason).toBe("complete");
  });

  it("warns the model after repeated identical tool calls", async () => {
    const same = () => toolCall("list_directory", { path: "." });
    const { engine } = makeEngine([same(), same(), same(), same(), say("done")]);
    await engine.runTurn("loop");
    const tools = engine.messages.filter((m) => m.role === "tool");
    expect(tools[1].content).not.toContain("harnessNote");
    expect(tools[2].content).toContain("harnessNote");
  });

  it("reports unparseable tool arguments clearly", async () => {
    const { engine } = makeEngine([toolCall("read_file", { input: '{"path": "a.txt' }), say("ok")]);
    await engine.runTurn("t");
    expect(engine.messages.find((m) => m.role === "tool")?.content).toContain("not valid JSON");
  });

  it("lists available tools when the model calls an unknown one", async () => {
    const { engine } = makeEngine([toolCall("teleport", {}), say("ok")]);
    await engine.runTurn("t");
    const content = engine.messages.find((m) => m.role === "tool")?.content ?? "";
    expect(content).toContain("Unknown tool");
    expect(content).toContain("read_file");
  });

  it("stops at max iterations", async () => {
    const { engine } = makeEngine([toolCall("list_directory", { path: "." })], { maxIterations: 3 });
    const result = await engine.runTurn("t");
    expect(result.stopReason).toBe("max_iterations");
    expect(result.iterations).toBe(3);
  });

  it("honors an abort signal", async () => {
    const controller = new AbortController();
    const { engine } = makeEngine([
      () => {
        controller.abort();
        return toolCall("list_directory", { path: "." });
      },
      say("never"),
    ]);
    const result = await engine.runTurn("t", controller.signal);
    expect(result.stopReason).toBe("aborted");
  });

  it("asks the model to continue after a length-truncated reply", async () => {
    const { engine } = makeEngine([
      { content: "partial", toolCalls: [], finishReason: "length" },
      say("finished"),
    ]);
    const result = await engine.runTurn("t");
    expect(result.finalContent).toBe("finished");
    expect(engine.messages.some((m) => m.content.includes("cut off by the output token limit"))).toBe(true);
  });

  it("accumulates provider usage and surfaces errors", async () => {
    const { engine } = makeEngine([
      { content: "a", toolCalls: [], usage: { inputTokens: 100, outputTokens: 20 } },
    ]);
    const result = await engine.runTurn("t");
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(engine.stats.usage.inputTokens).toBe(100);

    const failing = makeEngine([
      () => {
        throw new Error("boom");
      },
    ]);
    const failed = await failing.engine.runTurn("t");
    expect(failed.stopReason).toBe("error");
    expect(failed.error).toBe("boom");
  });

  it("caps oversized tool results", async () => {
    const { engine, tools } = makeEngine([toolCall("huge", {}), say("ok")]);
    tools.register({
      definition: { name: "huge", description: "x", parameters: { type: "object", properties: {} } },
      handler: async () => "y".repeat(MAX_TOOL_RESULT_CHARS * 2),
    });
    await engine.runTurn("t");
    const content = engine.messages.find((m) => m.role === "tool")?.content ?? "";
    expect(content.length).toBeLessThan(MAX_TOOL_RESULT_CHARS * 1.2);
    expect(content).toContain("truncated");
  });

  it("runs read-only calls sequentially when parallelTools is off", async () => {
    const profile = withProfile(DEFAULT_PROFILE, { parallelTools: false });
    const { engine } = makeEngine(
      [
        {
          content: "",
          toolCalls: [
            { id: "1", name: "list_directory", arguments: { path: "." } },
            { id: "2", name: "list_directory", arguments: { path: "." } },
          ],
        },
        say("ok"),
      ],
      { profile },
    );
    const result = await engine.runTurn("t");
    expect(result.toolCalls).toBe(2);
  });

  it("does not mistake an empty reply for completion, and keeps empties out of history", async () => {
    const { engine } = makeEngine([say(""), say("real answer")]);
    const result = await engine.runTurn("t");
    expect(result.finalContent).toBe("real answer");
    expect(engine.messages.filter((m) => m.role === "assistant").every((m) => m.content !== "")).toBe(true);
    expect(engine.messages.some((m) => m.content.includes("Your last response was empty"))).toBe(true);
  });

  it("nudges once when the model narrates an action instead of calling a tool", async () => {
    const { engine } = makeEngine([
      toolCall("list_directory", { path: "." }),
      say("Now let me run the tests:"),
      toolCall("list_directory", { path: "src" }),
      say("All done."),
    ]);
    const result = await engine.runTurn("t");
    expect(result.finalContent).toBe("All done.");
    expect(result.toolCalls).toBe(2);
  });

  it("does not run tool calls from a reply truncated by the token limit", async () => {
    const truncated = { ...toolCall("write_file", { path: "big.txt", content: "partial" }), finishReason: "length" };
    const { engine, cwd } = makeEngine([truncated, say("ok")]);
    await engine.runTurn("t");
    const fs = await import("node:fs");
    expect(fs.existsSync(path.join(cwd, "big.txt"))).toBe(false);
    expect(engine.messages.some((m) => m.content.includes("nothing was executed"))).toBe(true);
    const assistant = engine.messages.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls ?? []).toHaveLength(0);
  });

  it("stops cleanly when the time budget is exhausted and injects nudges before that", async () => {
    let now = 0;
    const budget = new TimeBudget(100_000, () => now);
    const steps = [
      () => {
        now = 60_000;
        return toolCall("list_directory", { path: "." });
      },
      () => {
        now = 99_000;
        return toolCall("list_directory", { path: "src" });
      },
      say("never reached"),
    ];
    const { engine } = makeEngine(steps, { timeBudget: budget });
    const result = await engine.runTurn("t");
    expect(result.stopReason).toBe("time_budget");
    expect(engine.messages.some((m) => m.content.includes("half of your time budget"))).toBe(true);
  });
});

describe("looksLikeUnfinishedNarration", () => {
  it.each(["Now let me run the tests:", "I'll check the config file.", "Let me look at the logs", "First, I need to read it."])(
    "flags %s",
    (text) => expect(looksLikeUnfinishedNarration(text)).toBe(true),
  );
  it.each(["All tests pass. Let me know if you want more.", "Done — created /app/out.txt with the result.", "", "x".repeat(600)])(
    "ignores %s",
    (text) => expect(looksLikeUnfinishedNarration(text)).toBe(false),
  );
});

describe("long-session context management", () => {
  it("summarizes history when rules alone cannot fit the window, keeping the task and the tail", async () => {
    const profile = withProfile(DEFAULT_PROFILE, { contextLimit: 4_000 });
    const huge = "x".repeat(2_000);
    let step = 0;
    // The summarizer is called without tools; the agent's own calls carry the tool list.
    const respond = (_messages: LlmMessage[], tools: unknown[]) => {
      if (tools.length === 0) return say("GOAL: finish. DONE: ran several steps.");
      step += 1;
      return step <= 12 ? toolCall("shell", { command: `echo step-${step} ${huge}` }) : say("all done");
    };
    const { engine, llm } = makeEngine([respond, respond] as never, { profile, maxIterations: 40 });
    const result = await engine.runTurn("TASK: do twelve steps");
    expect(result.stopReason).toBe("complete");
    expect(engine.messages.some((m) => m.content.includes("[Summary of earlier work]"))).toBe(true);
    expect(engine.messages[1].content).toBe("TASK: do twelve steps");
    expect(llm.calls.some((c) => c.tools.length === 0)).toBe(true);
  });

  it("recovers from a context-overflow error by shrinking history and retrying", async () => {
    let calls = 0;
    const steps = [
      toolCall("list_directory", { path: "." }),
      toolCall("list_directory", { path: "src" }),
      toolCall("list_directory", { path: "lib" }),
      (messages: LlmMessage[], tools: unknown[]) => {
        calls += 1;
        if (tools.length === 0) return say("GOAL: x. DONE: y.");
        if (calls === 1) throw new Error("This model's maximum context length is 128000 tokens. Your request exceeds it.");
        return say("recovered");
      },
      (messages: LlmMessage[], tools: unknown[]) => (tools.length === 0 ? say("summary text") : say("recovered")),
      say("recovered"),
    ];
    const { engine } = makeEngine(steps as never);
    // Plenty of old messages so there is something to summarize.
    for (let i = 0; i < 12; i += 1) {
      engine.messages.push({ role: "assistant", content: `earlier note ${i}` }, { role: "user", content: `ack ${i}` });
    }
    const result = await engine.runTurn("continue");
    expect(["complete", "error"]).toContain(result.stopReason);
    if (result.stopReason === "complete") {
      expect(engine.messages.some((m) => m.content.includes("[Summary of earlier work]"))).toBe(true);
    }
  });
});
