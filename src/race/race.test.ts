import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultArgs, resolveArgs, type CliArgs } from "../cli.js";
import type { LlmResponse } from "../llm/client.js";
import { SpendMeter } from "../llm/spend.js";
import { say, ScriptedLlm, toolCall } from "../testing/scripted-llm.js";
import { plainStyle } from "../tui/style.js";
import { stripAnsi } from "../tui/width.js";
import { Universe } from "../universe/universe.js";
import { closingSummary } from "../commands/race.js";
import { finalRows, liveRows } from "./board.js";
import { detectCheck, duplicates, parseModelSpec, planAttempts, rankAttempts, runRace, type Attempt } from "./race.js";

let previousHome: string | undefined;
let project: string;

beforeEach(() => {
  previousHome = process.env.REVCODE_HOME;
  process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  project = mkdtempSync(path.join(os.tmpdir(), "revcode-race-"));
  writeFileSync(path.join(project, "answer.txt"), "?\n");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.REVCODE_HOME;
  else process.env.REVCODE_HOME = previousHome;
});

const args = (overrides: Partial<CliArgs> = {}): CliArgs => ({
  ...resolveArgs({ ...defaultArgs(), cwd: project, headless: true }, { config: {}, warnings: [], files: [] }, {}),
  snapshot: false,
  mcp: false,
  hooks: false,
  instructions: false,
  ...overrides,
});

const usage = { inputTokens: 10_000, outputTokens: 1_000 };
const withUsage = (response: LlmResponse): LlmResponse => ({ ...response, usage });

/** A model that writes `value` to answer.txt, runs the check, and finishes. */
function writer(value: string, delayMs = 0): ScriptedLlm {
  const pause = (r: LlmResponse) => () => new Promise<LlmResponse>((resolve) => setTimeout(() => resolve(withUsage(r)), delayMs));
  return new ScriptedLlm([
    pause(toolCall("write_file", { path: "answer.txt", content: `${value}\n` })),
    pause(toolCall("shell", { command: "grep -q 42 answer.txt" })),
    pause(say(`answer is ${value}`)),
    pause(say("confirmed")),
  ]);
}

describe("runRace", () => {
  it("runs attempts in parallel copies, checks each, and ranks agreeing passes first", async () => {
    const llms = [writer("41", 30), writer("42", 30), writer("42", 30)];
    let concurrent = 0;
    let peak = 0;
    const spend = new SpendMeter();
    const result = await runRace({
      task: "make answer.txt contain 42",
      args: args({ model: "glm-5.2", provider: "zai" }),
      attempts: planAttempts({ tries: 3, model: "glm-5.2", provider: "zai" }),
      check: "grep -qx 42 answer.txt",
      spend,
      llmFor: (spec) => llms[spec.n - 1],
      onUpdate: (attempts) => {
        concurrent = attempts.filter((a) => a.status === "working").length;
        peak = Math.max(peak, concurrent);
      },
    });

    expect(peak).toBe(3);
    expect(result.attempts.map((a) => a.check?.passed)).toEqual([false, true, true]);
    expect(result.ranked.map((a) => a.spec.n)).toEqual([2, 3, 1]);
    expect(result.winner?.spec.n).toBe(2);
    expect(duplicates(result.ranked).get(3)).toBe(2);
    expect(readFileSync(path.join(project, "answer.txt"), "utf8")).toBe("?\n"); // nothing applied yet

    // Each attempt is its own copy, started from the same files.
    const ids = new Set(result.attempts.map((a) => a.universe!.id));
    expect(ids.size).toBe(3);
    expect(readFileSync(path.join(result.attempts[0].universe!.workDir, "answer.txt"), "utf8")).toBe("41\n");

    // Costs: per attempt, and one shared total.
    expect(result.attempts.every((a) => a.costUsd > 0)).toBe(true);
    expect(result.spentUsd).toBeCloseTo(result.attempts.reduce((sum, a) => sum + a.costUsd, 0), 9);
    expect(spend.spentUsd).toBe(result.spentUsd);

    const style = plainStyle();
    const board = finalRows(result, { style, width: 120, check: "grep -qx 42 answer.txt", spentUsd: result.spentUsd, priced: true }).map(stripAnsi);
    expect(board[0]).toMatch(/#2 +glm-5\.2 +✔ passed .*1 file \+1 −1 +❯ best/);
    expect(board[1]).toContain("same code as #2");
    expect(board[2]).toMatch(/#1 .*✘ failed \(1\)/);
    expect(board.at(-1)).toContain("spent $");
  });

  it("stops every attempt at a shared spending cap", async () => {
    const loop = (): LlmResponse => withUsage(toolCall("shell", { command: "true" }));
    const result = await runRace({
      task: "loop",
      // glm-5.2: each step costs $0.0184
      args: args({ model: "glm-5.2", provider: "zai", maxCost: 0.1 }),
      attempts: planAttempts({ tries: 2, model: "glm-5.2", provider: "zai" }),
      check: "true",
      llmFor: () => new ScriptedLlm([loop]),
    });
    expect(result.attempts.map((a) => a.stopReason)).toEqual(["cost_limit", "cost_limit"]);
    expect(result.spentUsd).toBeLessThanOrEqual(0.1);
    expect(result.winner).toBeUndefined(); // nothing changed, so nothing qualifies even though `true` passes
  });

  it("can be stopped, keeping every copy", async () => {
    const controller = new AbortController();
    const slow = () => new Promise<LlmResponse>((resolve) => setTimeout(() => resolve(withUsage(toolCall("shell", { command: "sleep 0.05" }))), 40));
    setTimeout(() => controller.abort(), 150);
    const result = await runRace({
      task: "slow",
      args: args(),
      attempts: planAttempts({ tries: 2, model: "glm-5.2", provider: "zai" }),
      check: "true",
      signal: controller.signal,
      llmFor: () => new ScriptedLlm([slow]),
    });
    expect(result.attempts.map((a) => a.stopReason)).toEqual(["aborted", "aborted"]);
    expect(result.attempts.every((a) => a.check === undefined)).toBe(true);
    expect(Universe.list({ projectRoot: project })).toHaveLength(2);
  });

  it("shows live progress", () => {
    const attempts = [
      { spec: { n: 1, model: "glm-5.2", provider: "zai" }, status: "working", startedAt: Date.now() - 41_000, steps: 12, activity: "edit_file src/slugify.js", costUsd: 0.03, files: 0, insertions: 0, deletions: 0 },
      { spec: { n: 2, model: "claude-sonnet-5-5", provider: "anthropic" }, status: "waiting", steps: 0, costUsd: 0, files: 0, insertions: 0, deletions: 0 },
    ] as Attempt[];
    const rows = liveRows(attempts, { style: plainStyle(), width: 110, spentUsd: 0.03, capUsd: 2, priced: true }).map(stripAnsi);
    expect(rows[0]).toMatch(/#1 +glm-5\.2 +. working +0:41 +12 steps +\$0\.03 +edit_file src\/slugify\.js/);
    expect(rows[1]).toMatch(/#2 +claude-sonnet-5-5 +waiting/);
    expect(rows[2]).toContain("spent $0.03 of $2.00");
  });
});

describe("ranking", () => {
  const attempt = (n: number, extra: Partial<Attempt>): Attempt =>
    ({ spec: { n, model: "m", provider: "zai" }, status: "done", steps: 1, costUsd: 0, files: 1, insertions: 1, deletions: 0, stopReason: "complete", ...extra }) as Attempt;
  const passed = { command: "t", exitCode: 0, passed: true, timedOut: false, durationMs: 1, tail: "" };

  it("prefers leaving existing tests alone, then smaller changes, then lower cost", () => {
    const edited = attempt(1, { check: passed, receipt: { testsModified: ["a.test.ts"] } as never });
    const big = attempt(2, { check: passed, insertions: 50 });
    const small = attempt(3, { check: passed, insertions: 2, costUsd: 0.2 });
    const smallCheap = attempt(4, { check: passed, insertions: 2, costUsd: 0.1 });
    expect(rankAttempts([edited, big, small, smallCheap], true).map((a) => a.spec.n)).toEqual([4, 3, 2, 1]);
  });

  it("without a check, trusts an attempt only if its own last test run passed", () => {
    const verified = attempt(1, { receipt: { testsModified: [], verification: { ran: true, afterLastChange: true, exitCode: 0 } } as never });
    const unverified = attempt(2, { receipt: { testsModified: [], verification: { ran: false, afterLastChange: false } } as never });
    expect(rankAttempts([unverified, verified], false).map((a) => a.spec.n)).toEqual([1, 2]);
  });
});

describe("planning", () => {
  it("spreads tries over models and reads provider prefixes", () => {
    expect(planAttempts({ model: "glm-5.2", provider: "zai" }).map((s) => s.n)).toEqual([1, 2, 3]);
    const mixed = planAttempts({ models: ["glm-5.2", "anthropic:claude-sonnet-5-5"], tries: 4, model: "x", provider: "zai" });
    expect(mixed.map((s) => `${s.provider}/${s.model}`)).toEqual(["zai/glm-5.2", "anthropic/claude-sonnet-5-5", "zai/glm-5.2", "anthropic/claude-sonnet-5-5"]);
    expect(planAttempts({ models: ["a", "b"], model: "x", provider: "zai" })).toHaveLength(2);
    expect(parseModelSpec("ollama:qwen3:8b")).toEqual({ model: "qwen3:8b", provider: "ollama" });
    expect(parseModelSpec("qwen3:8b", "ollama")).toEqual({ model: "qwen3:8b", provider: "ollama" });
    expect(() => planAttempts({ tries: 13, model: "m" })).toThrow(/limited to 12/);
  });

  it("finds the project's test command", () => {
    const dir = (files: Record<string, string>): string => {
      const d = mkdtempSync(path.join(os.tmpdir(), "revcode-detect-"));
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
        writeFileSync(path.join(d, name), body);
      }
      return d;
    };
    expect(detectCheck(dir({ "package.json": '{"scripts":{"test":"vitest run"}}' }))).toBe("npm test");
    expect(detectCheck(dir({ "package.json": '{"scripts":{"test":"jest"}}', "pnpm-lock.yaml": "" }))).toBe("pnpm test");
    expect(detectCheck(dir({ "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' }))).toBeUndefined();
    expect(detectCheck(dir({ "pyproject.toml": "[tool.pytest.ini_options]\n" }))).toBe("python3 -m pytest -q");
    expect(detectCheck(dir({ "go.mod": "module x\n" }))).toBe("go test ./...");
    expect(detectCheck(dir({ "Cargo.toml": "[package]\n" }))).toBe("cargo test");
    expect(detectCheck(dir({ Makefile: "build:\n\tcc x.c\ntest:\n\t./t\n" }))).toBe("make test");
    expect(detectCheck(dir({ "README.md": "hi" }))).toBeUndefined();
  });
});

describe("closingSummary", () => {
  it("keeps the agent's last paragraph, plain and short", () => {
    const message = "Audit:\n1. tests pass\n2. clean\n\n**Summary**: Fixed `slugify.js` by normalizing accents and trimming separators. All 3 tests pass.";
    expect(closingSummary(message, 80)).toEqual(["Fixed slugify.js by normalizing accents and trimming separators. All 3 tests", "pass."]);
    expect(closingSummary("word ".repeat(100), 20)).toHaveLength(3);
    expect(closingSummary("", 20)).toEqual([]);
  });
});
