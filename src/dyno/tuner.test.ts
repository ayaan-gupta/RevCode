import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, type HarnessProfile } from "../harness/profile.js";
import type { TaskRunResult } from "./runner.js";
import { alternatives, tuneProfile, type RunTaskFn, type TuneEvent } from "./tuner.js";
import { median, signTestP } from "./stats.js";
import type { DynoCategory, DynoTask } from "./types.js";

function task(id: string, category: DynoCategory = "edit"): DynoTask {
  return {
    id,
    title: id,
    category,
    difficulty: 1,
    instruction: id,
    maxIterations: 10,
    timeoutSec: 30,
    setup: () => undefined,
    grade: () => ({ passed: true, detail: "" }),
    oracle: () => undefined,
  };
}

function result(t: DynoTask, passed: boolean, toolCalls = 8): TaskRunResult {
  return { taskId: t.id, passed, detail: "", stopReason: "complete", iterations: toolCalls, toolCalls, toolErrors: 0, durationMs: 10, inputTokens: 100, outputTokens: 10 };
}

const EDIT_MODES = ["replace", "patch", "anchored", "whole"] as const;

describe("tuneProfile", () => {
  const tasks = [task("e1"), task("e2"), task("e3"), task("e4"), task("s1", "shell"), task("s2", "shell")];

  it("stops immediately when the default already passes (almost) everything", async () => {
    let runs = 0;
    const run: RunTaskFn = async (t) => (runs += 1, result(t, true));
    const outcome = await tuneProfile({ tasks, runTask: run, editModes: EDIT_MODES });
    expect(outcome.ceilingReached).toBe(true);
    expect(outcome.improved).toBe(false);
    expect(runs).toBe(tasks.length);
    expect(outcome.verdict).toContain("nothing worth tuning");
  });

  it("finds and confirms a real improvement", async () => {
    // Edit tasks only succeed with apply_patch; shell tasks always succeed.
    const run: RunTaskFn = async (t, profile) => result(t, t.category === "shell" || profile.editMode === "patch");
    const events: TuneEvent[] = [];
    const outcome = await tuneProfile({ tasks, runTask: run, editModes: EDIT_MODES, onProgress: (e) => events.push(e), budget: 200 });

    expect(outcome.improved).toBe(true);
    expect(outcome.finalProfile.editMode).toBe("patch");
    expect(outcome.changes).toEqual(["editMode: replace → patch"]);
    expect(outcome.baseline.passes).toBe(2);
    expect(outcome.final.passes).toBe(6);
    expect(outcome.fixed.sort()).toEqual(["e1", "e2", "e3", "e4"]);
    expect(outcome.broke).toEqual([]);
    // 4 fixed / 0 broken is only p=0.125 (two-sided exact): the tuner must say so rather than overclaim.
    expect(outcome.pValue).toBeCloseTo(0.125, 5);
    expect(outcome.verdict).toContain("could be chance");
    expect(outcome.candidates.find((c) => c.knob === "editMode" && c.value === "patch")?.accepted).toBe(true);
    expect(events.some((e) => e.type === "confirm-start")).toBe(true);
    expect(outcome.runsSpent).toBeLessThanOrEqual(200);
  });

  it("reports a confident verdict when the evidence is strong", async () => {
    const many = Array.from({ length: 8 }, (_, i) => task(`edit-${i}`));
    const run: RunTaskFn = async (t, profile) => result(t, profile.editMode === "patch");
    const outcome = await tuneProfile({ tasks: many, runTask: run, editModes: EDIT_MODES, budget: 500 });
    expect(outcome.pValue).toBeLessThan(0.05);
    expect(outcome.verdict).toContain("Confirmed against a fresh baseline");
  });

  it("keeps the defaults when no change matters", async () => {
    const run: RunTaskFn = async (t) => result(t, t.category === "shell");
    const outcome = await tuneProfile({ tasks, runTask: run, editModes: EDIT_MODES, budget: 500 });
    expect(outcome.improved).toBe(false);
    expect(outcome.finalProfile).toEqual(DEFAULT_PROFILE);
    expect(outcome.verdict).toContain("keeping the defaults");
    expect(outcome.changes).toEqual([]);
  });

  it("does not adopt a no-op change just because failed tasks pass on a re-run (regression to the mean)", async () => {
    // Every task fails the first time it is run and passes ever after, regardless of profile.
    const seen = new Set<string>();
    const run: RunTaskFn = async (t) => {
      const first = !seen.has(t.id);
      seen.add(t.id);
      return result(t, !first);
    };
    const outcome = await tuneProfile({ tasks, runTask: run, editModes: EDIT_MODES, budget: 500 });
    // Candidates look great on the screen (they are re-runs)…
    expect(outcome.candidates.some((c) => c.accepted)).toBe(true);
    // …but a fresh baseline re-measurement exposes that nothing actually changed.
    expect(outcome.improved).toBe(false);
    expect(outcome.finalProfile).toEqual(DEFAULT_PROFILE);
    expect(outcome.baseline.passes).toBe(tasks.length);
  });

  it("accepts equal-pass changes that are clearly cheaper", async () => {
    const run: RunTaskFn = async (t, profile) =>
      result(t, t.category === "shell", profile.toolSchema === "flat" ? 4 : 10);
    const outcome = await tuneProfile({ tasks, runTask: run, editModes: EDIT_MODES, knobs: ["toolSchema"], budget: 200 });
    expect(outcome.improved).toBe(true);
    expect(outcome.finalProfile.toolSchema).toBe("flat");
  });

  it("never exceeds the run budget and says so", async () => {
    let runs = 0;
    const run: RunTaskFn = async (t, profile) => (runs += 1, result(t, t.category === "shell" || profile.editMode === "patch"));
    const outcome = await tuneProfile({ tasks, runTask: run, editModes: EDIT_MODES, budget: 14 });
    expect(runs).toBeLessThanOrEqual(14);
    expect(outcome.runsSpent).toBe(runs);
    expect(outcome.budgetExhausted || outcome.verdict.includes("budget")).toBe(true);
    // With too little left to confirm, an unconfirmed profile must not be adopted.
    expect(outcome.finalProfile).toEqual(DEFAULT_PROFILE);
  });

  it("gives the same answer with parallel workers", async () => {
    const run: RunTaskFn = async (t, profile) => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      return result(t, t.category === "shell" || profile.editMode === "patch");
    };
    const outcome = await tuneProfile({ tasks, runTask: run, editModes: EDIT_MODES, concurrency: 4, budget: 300 });
    expect(outcome.finalProfile.editMode).toBe("patch");
    expect(outcome.improved).toBe(true);
  });

  it("only searches edit modes that are implemented", () => {
    expect(alternatives("editMode", DEFAULT_PROFILE, ["replace", "whole"])).toEqual(["whole"]);
    expect(alternatives("toolSchema", DEFAULT_PROFILE, [])).toEqual(["flat"]);
    expect(alternatives("parallelTools", DEFAULT_PROFILE, [])).toEqual([false]);
  });

  it("supports multiple trials per task", async () => {
    const run: RunTaskFn = async (t, profile) => result(t, t.category === "shell" || profile.editMode === "patch");
    const outcome = await tuneProfile({ tasks, trials: 2, runTask: run, editModes: EDIT_MODES, budget: 500 });
    expect(outcome.baseline.runs).toBe(tasks.length * 2);
    expect(outcome.improved).toBe(true);
  });

  it("reports the profile it started from as unchanged when given a custom baseline", async () => {
    const baseline: HarnessProfile = { ...DEFAULT_PROFILE, promptStyle: "terse" };
    const run: RunTaskFn = async (t) => result(t, t.category === "shell");
    const outcome = await tuneProfile({ tasks, runTask: run, baseline, editModes: EDIT_MODES, budget: 500 });
    expect(outcome.finalProfile).toEqual(baseline);
  });
});

describe("stats", () => {
  it("sign test", () => {
    expect(signTestP(0, 0)).toBe(1);
    expect(signTestP(4, 0)).toBeCloseTo(0.125, 5);
    expect(signTestP(5, 5)).toBeCloseTo(1, 5);
    expect(signTestP(9, 1)).toBeLessThan(0.05);
  });
  it("median", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});
