import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultArgs, resolveArgs, type CliArgs } from "../cli.js";
import { createRuntime } from "../agent/setup.js";
import { runTrackedTurn } from "../agent/turn.js";
import { formatReceipt } from "../universe/receipts.js";
import { say, ScriptedLlm, toolCall } from "../testing/scripted-llm.js";
import type { LlmResponse } from "./client.js";
import { costOf, formatUsd, priceFor, validatePriceTable } from "./pricing.js";
import { MeteredLlm, SpendMeter, isSpendCapError } from "./spend.js";

describe("pricing", () => {
  it("finds built-in, dated, vendor-prefixed and overridden prices", () => {
    expect(priceFor("claude-sonnet-5-5", "anthropic")).toEqual({ input: 2, output: 10, cachedInput: 0.2 });
    expect(priceFor("claude-haiku-4-5-20251001", "anthropic")?.input).toBe(1);
    expect(priceFor("anthropic/claude-opus-5-5", "openrouter")?.output).toBe(20);
    expect(priceFor("glm-5.2-air", "zai")).toBeUndefined();
    expect(priceFor("my-model", "openai-compat", { "my-model": { input: 1, output: 2 } })).toEqual({ input: 1, output: 2 });
    expect(priceFor("glm-5.2", "zai", { "glm-5.2": { input: 0, output: 0 } })).toEqual({ input: 0, output: 0 });
    expect(priceFor("qwen3:8b", "ollama")?.input).toBe(0);
  });

  it("prices fresh, cached and cache-write input separately", () => {
    const price = { input: 2, output: 10, cachedInput: 0.2 };
    // 1M fresh in = $2, 1M cached = $0.20, 1M written = $2.50, 1M out = $10
    const usage = { inputTokens: 3_000_000, cachedInputTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(costOf(usage, price)).toBeCloseTo(14.7, 6);
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("validates config price tables", () => {
    const { table, problems } = validatePriceTable({ ok: { input: 1, output: 2, cachedInput: 0.1 }, bad: { input: "x" } });
    expect(table).toEqual({ ok: { input: 1, output: 2, cachedInput: 0.1 } });
    expect(problems.join()).toContain("pricing.bad");
  });
});

const usage = (input: number, output: number): LlmResponse["usage"] => ({ inputTokens: input, outputTokens: output });

describe("MeteredLlm", () => {
  it("records cost and refuses a call that would cross the cap", async () => {
    const meter = new SpendMeter(0.025);
    const inner = new ScriptedLlm([{ content: "a", toolCalls: [], usage: usage(1_000, 1_000) }]);
    // $1 in / $10 out per million: each call costs $0.011
    const llm = new MeteredLlm(inner, meter, { input: 1, output: 10 }, "m");
    await llm.complete([{ role: "user", content: "hi" }]);
    expect(meter.spentUsd).toBeCloseTo(0.011, 6);
    expect(llm.check().stop).toBe(false);
    await llm.complete([{ role: "user", content: "hi" }]);
    // Spent $0.022; the next call (~$0.011) would cross $0.025.
    expect(llm.check()).toMatchObject({ stop: true, reason: expect.stringContaining("Spending cap reached") });
    await expect(llm.complete([{ role: "user", content: "hi" }])).rejects.toSatisfy(isSpendCapError);
    expect(inner.calls).toHaveLength(2);
  });

  it("nudges the model once at 80% of the cap", async () => {
    const meter = new SpendMeter(0.1);
    meter.record(0.085);
    const llm = new MeteredLlm(new ScriptedLlm([say("x")]), meter, { input: 1, output: 1 }, "m");
    expect(llm.check().nudge).toContain("spending cap");
    expect(llm.check().nudge).toBeUndefined();
  });

  it("prefers the cost a provider reports", async () => {
    const meter = new SpendMeter();
    const llm = new MeteredLlm(new ScriptedLlm([{ content: "x", toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.5 } }]), meter, undefined, "m");
    await llm.complete([{ role: "user", content: "hi" }]);
    expect(meter.spentUsd).toBe(0.5);
  });

  it("stops rather than overspend when the cost can't be known", async () => {
    const meter = new SpendMeter(1);
    const llm = new MeteredLlm(new ScriptedLlm([{ content: "x", toolCalls: [], usage: usage(10, 10) }]), meter, undefined, "mystery");
    await llm.complete([{ role: "user", content: "hi" }]);
    expect(llm.check()).toMatchObject({ stop: true, reason: expect.stringContaining("can't be enforced") });
  });

  it("counts in-flight calls, so parallel attempts share one cap", async () => {
    const meter = new SpendMeter(0.03);
    const slow = (): Promise<LlmResponse> => new Promise((resolve) => setTimeout(() => resolve({ content: "x", toolCalls: [], usage: usage(0, 1_000) }), 20));
    const make = (): MeteredLlm => new MeteredLlm(new ScriptedLlm([slow, slow, slow]), meter, { input: 0, output: 10 }, "m");
    const [a, b] = [make(), make()];
    await Promise.all([a.complete([]), b.complete([])]); // $0.02 spent, each estimates $0.01 next
    const first = a.complete([]); // reserves $0.01 → $0.03 committed
    await expect(b.complete([])).rejects.toSatisfy(isSpendCapError);
    await first;
    expect(meter.spentUsd).toBeCloseTo(0.03, 6);
  });
});

describe("--max-cost in a session", () => {
  let previousHome: string | undefined;
  let project: string;
  beforeEach(() => {
    previousHome = process.env.REVCODE_HOME;
    process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
    project = mkdtempSync(path.join(os.tmpdir(), "revcode-proj-"));
    writeFileSync(path.join(project, "a.txt"), "a\n");
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.REVCODE_HOME;
    else process.env.REVCODE_HOME = previousHome;
  });

  const args = (overrides: Partial<CliArgs>): CliArgs => ({
    ...resolveArgs({ ...defaultArgs(), cwd: project, headless: true }, { config: {}, warnings: [], files: [] }, {}),
    snapshot: false,
    mcp: false,
    hooks: false,
    ...overrides,
  });

  it("ends the turn cleanly at the cap and says so in the receipt", async () => {
    const step = (): LlmResponse => ({ ...toolCall("shell", { command: "echo step" }), usage: usage(100_000, 10_000) });
    const llm = new ScriptedLlm([step, step, step, step, step, say("done")]);
    // glm-5.2 is $1.40 in / $4.40 out: each step costs $0.184
    const rt = await createRuntime({ args: args({ model: "glm-5.2", provider: "zai", maxCost: 0.5 }), interactive: false, llm, hermetic: true });
    const { result, receipt } = await runTrackedTurn(rt, "loop");
    await rt.dispose();
    expect(result.stopReason).toBe("cost_limit");
    expect(llm.calls).toHaveLength(2);
    expect(rt.spend.spentUsd).toBeLessThanOrEqual(0.5);
    expect(receipt.costUsd).toBeCloseTo(0.368, 3);
    expect(formatReceipt(receipt).join("\n")).toContain("spending cap reached");
  });

  it("refuses to start with a cap it cannot enforce", async () => {
    await expect(
      createRuntime({ args: args({ model: "mystery-model", provider: "openai-compat", maxCost: 1 }), interactive: false, llm: new ScriptedLlm([say("x")]), hermetic: true }),
    ).rejects.toThrow(/needs to know what mystery-model costs/);
  });
});
