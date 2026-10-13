import { describe, expect, it } from "vitest";
import { TimeBudget } from "./time-budget.js";
import { challengeMessage, createCompletionGate } from "./completion-gate.js";

describe("TimeBudget", () => {
  it("nudges once per threshold and expires near the limit", () => {
    let now = 0;
    const budget = new TimeBudget(100_000, () => now);
    expect(budget.check()).toMatchObject({ expired: false, nudge: undefined });

    now = 50_000;
    expect(budget.check().nudge).toContain("half");
    expect(budget.check().nudge).toBeUndefined();

    now = 82_000;
    expect(budget.check().nudge).toContain("running low");

    now = 93_000;
    expect(budget.check().nudge).toContain("Almost out");

    now = 98_000;
    expect(budget.check().expired).toBe(true);
  });

  it("collapses skipped thresholds into the latest message", () => {
    let now = 0;
    const budget = new TimeBudget(100_000, () => now);
    now = 95_000;
    expect(budget.check().nudge).toContain("Almost out");
    expect(budget.check().nudge).toBeUndefined();
  });
});

describe("completion gate", () => {
  const act = (gate: ReturnType<typeof createCompletionGate>, name: string) =>
    gate.middleware.after?.({ call: { id: "1", name, arguments: {} }, iteration: 0, result: {}, durationMs: 1 });

  it("quotes the task, challenges after real work, and re-challenges only after new activity", () => {
    const gate = createCompletionGate("Write /app/out.txt containing 42");
    const check = () => gate.gate.check({ finalContent: "done", turnToolCalls: 3 });

    act(gate, "shell");
    const first = check();
    expect(first).toContain("Write /app/out.txt containing 42");
    expect(check()).toBeUndefined(); // model confirmed without doing anything new

    act(gate, "shell");
    expect(check()).toBeDefined(); // it fixed something, so challenge once more
    act(gate, "shell");
    expect(check()).toBeUndefined(); // capped at two challenges
  });

  it("never challenges a turn that only read things or used no tools", () => {
    const gate = createCompletionGate("what is 2+2?", 2, (name) => name === "read_file");
    expect(gate.gate.check({ finalContent: "4", turnToolCalls: 0 })).toBeUndefined();
    act(gate, "read_file");
    expect(gate.gate.check({ finalContent: "4", turnToolCalls: 1 })).toBeUndefined();
    act(gate, "write_file");
    expect(gate.gate.check({ finalContent: "done", turnToolCalls: 2 })).toBeDefined();
  });

  it("truncates very long tasks", () => {
    expect(challengeMessage("x".repeat(10_000))).toContain("task truncated");
  });
});
