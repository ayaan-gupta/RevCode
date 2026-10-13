import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, withProfile } from "../harness/profile.js";
import { formatDryRun, formatTuneProgress, renderLiftCard } from "./report.js";
import type { Evaluation, TuneResult } from "./tuner.js";
import type { DynoTask } from "./types.js";

const task = (id: string, category: DynoTask["category"]): DynoTask => ({
  id, title: id, category, difficulty: 1, instruction: "", maxIterations: 5, timeoutSec: 5, setup() {}, grade: () => ({ passed: true, detail: "" }), oracle() {},
});

function evaluation(passes: number, runs: number, per: Record<string, number>): Evaluation {
  return {
    profile: DEFAULT_PROFILE,
    passes,
    runs,
    score: passes / runs,
    medianToolCalls: 9,
    meanTokens: 100,
    perTask: new Map(Object.entries(per).map(([id, p]) => [id, { passes: p, runs: 1, toolCalls: [9], tokens: [100], durationsMs: [1] }])),
  };
}

describe("renderLiftCard", () => {
  const tasks = [task("a", "edit"), task("b", "edit"), task("c", "shell")];
  const improved: TuneResult = {
    baseline: evaluation(1, 3, { a: 0, b: 0, c: 1 }),
    initialBaseline: evaluation(1, 3, { a: 0, b: 0, c: 1 }),
    final: evaluation(3, 3, { a: 1, b: 1, c: 1 }),
    finalProfile: withProfile(DEFAULT_PROFILE, { editMode: "patch" }),
    changes: ["editMode: replace → patch"],
    improved: true,
    verdict: "Confirmed against a fresh baseline: 1/3 → 3/3.",
    candidates: [{ knob: "editMode", value: "patch", screenScore: 1, screenPasses: 2, screenRuns: 2, medianToolCalls: 6, accepted: true, reason: "+2 screen passes" }],
    screen: ["a", "b"],
    runsSpent: 20,
    budget: 100,
    budgetExhausted: false,
    fixed: ["a", "b"],
    broke: [],
    pValue: 0.5,
    ceilingReached: false,
    tokens: { input: 12_000, output: 3_000 },
    elapsedMs: 180_000,
  };

  it("summarizes lift, changes, per-category scores and the search log", () => {
    const card = renderLiftCard(improved, { provider: "zai", model: "glm-5.2", suite: "builtin", tasks, trials: 1 });
    expect(card).toContain("`zai/glm-5.2`");
    expect(card).toContain("33% → 100%");
    expect(card).toContain("+67 pts");
    expect(card).toContain("`editMode: replace → patch`");
    expect(card).toContain("| edit | 0/2 | 2/2 |");
    expect(card).toContain("| shell | 1/1 | 1/1 |");
    expect(card).toContain("`editMode=patch`");
    expect(card).toContain("20/100 runs");
  });

  it("is honest when nothing improved", () => {
    const card = renderLiftCard(
      { ...improved, improved: false, changes: [], final: improved.baseline, fixed: [], broke: [], verdict: "No single change beat the defaults on the screen; keeping the defaults." },
      { provider: "zai", model: "m", suite: "builtin", tasks, trials: 2 },
    );
    expect(card).toContain("defaults kept");
    expect(card).not.toContain("→ 100%");
  });
});

describe("progress + dry run", () => {
  it("formats events and stays quiet on done", () => {
    expect(formatTuneProgress({ type: "baseline-start", runs: 5 })).toContain("5 task attempts");
    expect(formatTuneProgress({ type: "run", task: "t", knob: "baseline", passed: false, done: 1, total: 5 })).toContain("✘ t");
    expect(formatTuneProgress({ type: "confirm-start", runs: 12 })).toContain("12 runs");
  });
  it("describes the plan without spending anything, and flags a thin budget", () => {
    const lines = formatDryRun([task("a", "edit")], 2, 80, ["replace", "whole"]);
    expect(lines.join("\n")).toContain("No model calls were made");
    expect(lines.join("\n")).toContain("replace, whole");

    const many = Array.from({ length: 16 }, (_, i) => task(`t${i}`, "edit"));
    expect(formatDryRun(many, 1, 60, ["replace"]).join("\n")).toContain("thin search");
    expect(formatDryRun(many, 1, 200, ["replace"]).join("\n")).not.toContain("thin search");
  });
});
