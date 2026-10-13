/**
 * Dyno: coordinate-descent tuning of the harness profile for one model.
 *
 * Phases
 *   1. BASELINE   run the full suite with the default profile.
 *                 If the model already passes (almost) everything there is
 *                 nothing to gain, so stop before spending more.
 *   2. SEARCH     turn one knob at a time on a SCREEN: the tasks the baseline
 *                 failed, plus a few passing tasks to catch regressions. Keep a
 *                 change if it passes more screen tasks (ties broken by fewer
 *                 tool calls). Knobs are tried in order of expected impact so a
 *                 small budget still covers the likely winners.
 *   3. CONFIRM    re-run the full suite with the winner. Accept it only if it
 *                 beats the baseline there too; otherwise report that no reliable
 *                 improvement was found and keep the defaults. This guards
 *                 against "winning" the screen by luck.
 *
 * The runner is injected, so the search logic is tested without any model.
 */

import { AVAILABLE_EDIT_MODES } from "../tools/edit-modes.js";
import {
  DEFAULT_PROFILE,
  PROFILE_SEARCH_SPACE,
  describeProfileDiff,
  profileKey,
  withProfile,
  type EditMode,
  type HarnessProfile,
  type TunableKnob,
} from "../harness/profile.js";
import { mean, median, signTestP } from "./stats.js";
import type { TaskRunResult } from "./runner.js";
import type { DynoTask } from "./types.js";

export type RunTaskFn = (task: DynoTask, profile: HarnessProfile, trial: number) => Promise<TaskRunResult>;

export interface TuneOptions {
  tasks: DynoTask[];
  runTask: RunTaskFn;
  baseline?: HarnessProfile;
  trials?: number;
  /** Maximum number of task runs to spend in total. */
  budget?: number;
  concurrency?: number;
  /** Knob order (most impactful first). */
  knobs?: readonly TunableKnob[];
  /** Edit modes the search may use (default: all implemented). */
  editModes?: readonly EditMode[];
  /** Baseline pass rate at/above which tuning stops early. */
  ceiling?: number;
  /** Max number of passing tasks added to the screen for regression detection. */
  screenPassing?: number;
  onProgress?: (event: TuneEvent) => void;
}

export type TuneEvent =
  | { type: "baseline-start"; runs: number }
  | { type: "run"; task: string; knob: string; passed: boolean; done: number; total: number }
  | { type: "baseline-done"; evaluation: Evaluation }
  | { type: "candidate"; knob: TunableKnob; value: unknown; evaluation: Evaluation; accepted: boolean; reason: string }
  | { type: "confirm-start"; runs: number }
  | { type: "done"; result: TuneResult };

export interface Evaluation {
  profile: HarnessProfile;
  /** task id → passes out of `trials`. */
  perTask: Map<string, { passes: number; runs: number; toolCalls: number[]; tokens: number[]; durationsMs: number[] }>;
  passes: number;
  runs: number;
  /** passes / runs */
  score: number;
  medianToolCalls: number;
  meanTokens: number;
}

export interface CandidateRecord {
  knob: TunableKnob;
  value: unknown;
  screenScore: number;
  screenPasses: number;
  screenRuns: number;
  medianToolCalls: number;
  accepted: boolean;
  reason: string;
}

export interface TuneResult {
  /**
   * The baseline the final profile is compared against. When a candidate was
   * confirmed this is a FRESH re-measurement, not the run that picked the screen
   * (tasks chosen for having failed would otherwise "improve" by chance alone).
   */
  baseline: Evaluation;
  /** The first baseline run, which selected the screen. */
  initialBaseline: Evaluation;
  /** Full-suite evaluation of the final profile (equals baseline when nothing was accepted). */
  final: Evaluation;
  finalProfile: HarnessProfile;
  changes: string[];
  improved: boolean;
  /** Why we stopped / what to conclude, in plain words. */
  verdict: string;
  candidates: CandidateRecord[];
  screen: string[];
  runsSpent: number;
  budget: number;
  budgetExhausted: boolean;
  /** Tasks the final profile fixed / broke relative to the baseline (any trial majority). */
  fixed: string[];
  broke: string[];
  pValue: number;
  ceilingReached: boolean;
  tokens: { input: number; output: number };
  elapsedMs: number;
}

const DEFAULT_KNOB_ORDER: readonly TunableKnob[] = [
  "editMode",
  "promptStyle",
  "toolSchema",
  "completionGate",
  "verifyGate",
  "parallelTools",
  "temperature",
];

export async function tuneProfile(options: TuneOptions): Promise<TuneResult> {
  const started = Date.now();
  const trials = Math.max(1, options.trials ?? 1);
  const budget = options.budget ?? 150;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const ceiling = options.ceiling ?? 0.95;
  const editModes = options.editModes ?? AVAILABLE_EDIT_MODES;
  const baselineProfile = options.baseline ?? DEFAULT_PROFILE;
  const tokens = { input: 0, output: 0 };
  let runsSpent = 0;
  let done = 0;
  let totalPlanned = 0;

  const afford = (runs: number): boolean => runsSpent + runs <= budget;
  // Reserve what the confirmation will need so the search can't starve it.
  const confirmCost = 2 * options.tasks.length * trials;

  async function evaluate(profile: HarnessProfile, tasks: DynoTask[], label: string): Promise<Evaluation> {
    const jobs: Array<{ task: DynoTask; trial: number }> = [];
    for (const task of tasks) {
      for (let trial = 0; trial < trials; trial += 1) jobs.push({ task, trial });
    }
    runsSpent += jobs.length;
    totalPlanned = jobs.length;
    done = 0;

    const results = await mapPool(jobs, concurrency, async (job) => {
      const result = await options.runTask(job.task, profile, job.trial);
      done += 1;
      tokens.input += result.inputTokens;
      tokens.output += result.outputTokens;
      options.onProgress?.({ type: "run", task: job.task.id, knob: label, passed: result.passed, done, total: totalPlanned });
      return { job, result };
    });

    const perTask: Evaluation["perTask"] = new Map();
    for (const { job, result } of results) {
      const entry = perTask.get(job.task.id) ?? { passes: 0, runs: 0, toolCalls: [], tokens: [], durationsMs: [] };
      entry.runs += 1;
      if (result.passed) entry.passes += 1;
      entry.toolCalls.push(result.toolCalls);
      entry.tokens.push(result.inputTokens + result.outputTokens);
      entry.durationsMs.push(result.durationMs);
      perTask.set(job.task.id, entry);
    }
    const passes = [...perTask.values()].reduce((n, e) => n + e.passes, 0);
    const runs = [...perTask.values()].reduce((n, e) => n + e.runs, 0);
    return {
      profile,
      perTask,
      passes,
      runs,
      score: runs === 0 ? 0 : passes / runs,
      medianToolCalls: median([...perTask.values()].flatMap((e) => e.toolCalls)),
      meanTokens: mean([...perTask.values()].flatMap((e) => e.tokens)),
    };
  }

  // --- 1. baseline -------------------------------------------------------------
  options.onProgress?.({ type: "baseline-start", runs: options.tasks.length * trials });
  const baseline = await evaluate(baselineProfile, options.tasks, "baseline");
  options.onProgress?.({ type: "baseline-done", evaluation: baseline });

  const finish = (
    partial: Partial<TuneResult> & { finalProfile: HarnessProfile; final: Evaluation; verdict: string },
  ): TuneResult => {
    const measured = partial.baseline ?? baseline;
    const { fixed, broke } = diffTasks(measured, partial.final);
    const result: TuneResult = {
      baseline: measured,
      initialBaseline: baseline,
      changes: describeProfileDiff(baselineProfile, partial.finalProfile),
      improved: false,
      candidates: [],
      screen: [],
      runsSpent,
      budget,
      budgetExhausted: runsSpent >= budget,
      fixed,
      broke,
      pValue: signTestP(fixed.length, broke.length),
      ceilingReached: false,
      tokens,
      elapsedMs: Date.now() - started,
      ...partial,
    };
    options.onProgress?.({ type: "done", result });
    return result;
  };

  if (baseline.score >= ceiling) {
    return finish({
      finalProfile: baselineProfile,
      final: baseline,
      ceilingReached: true,
      verdict: `The default harness already passes ${percent(baseline.score)} of the suite — nothing worth tuning for this model.`,
    });
  }

  // --- 2. search ---------------------------------------------------------------
  const failing = options.tasks.filter((t) => (baseline.perTask.get(t.id)?.passes ?? 0) < trials);
  const passing = options.tasks
    .filter((t) => !failing.includes(t))
    .sort((a, b) => median(baseline.perTask.get(b.id)?.toolCalls ?? []) - median(baseline.perTask.get(a.id)?.toolCalls ?? []))
    .slice(0, options.screenPassing ?? 4);
  const screen = [...failing, ...passing];

  let best = baselineProfile;
  let bestScreen = await evaluateOnScreenFromBaseline(baseline, screen);
  const candidates: CandidateRecord[] = [];
  const tried = new Set<string>([profileKey(best)]);
  const order = options.knobs ?? DEFAULT_KNOB_ORDER;

  for (const knob of order) {
    for (const value of alternatives(knob, best, editModes)) {
      const candidate = withProfile(best, { [knob]: value } as Partial<HarnessProfile>);
      const key = profileKey(candidate);
      if (tried.has(key)) continue;
      tried.add(key);

      if (!afford(screen.length * trials + confirmCost)) {
        return finishSearch("budget");
      }
      const evaluation = await evaluate(candidate, screen, `${knob}=${String(value)}`);
      const better =
        evaluation.passes > bestScreen.passes ||
        (evaluation.passes === bestScreen.passes && evaluation.medianToolCalls <= bestScreen.medianToolCalls * 0.85 && bestScreen.medianToolCalls > 0);
      const reason = better
        ? evaluation.passes > bestScreen.passes
          ? `+${evaluation.passes - bestScreen.passes} screen pass${evaluation.passes - bestScreen.passes === 1 ? "" : "es"}`
          : "same passes, ≥15% fewer tool calls"
        : evaluation.passes < bestScreen.passes
          ? `${evaluation.passes - bestScreen.passes} screen passes`
          : "no gain";
      candidates.push({
        knob,
        value,
        screenScore: evaluation.score,
        screenPasses: evaluation.passes,
        screenRuns: evaluation.runs,
        medianToolCalls: evaluation.medianToolCalls,
        accepted: better,
        reason,
      });
      options.onProgress?.({ type: "candidate", knob, value, evaluation, accepted: better, reason });
      if (better) {
        best = candidate;
        bestScreen = evaluation;
      }
    }
  }
  return finishSearch("complete");

  // --- 3. confirm --------------------------------------------------------------
  async function finishSearch(why: "complete" | "budget"): Promise<TuneResult> {
    const screenIds = screen.map((t) => t.id);
    if (profileKey(best) === profileKey(baselineProfile)) {
      return finish({
        finalProfile: baselineProfile,
        final: baseline,
        candidates,
        screen: screenIds,
        verdict:
          why === "budget"
            ? "Ran out of budget before finding an improvement; keeping the defaults."
            : "No single change beat the defaults on the screen; keeping the defaults.",
      });
    }
    if (!afford(2 * options.tasks.length * trials)) {
      return finish({
        finalProfile: baselineProfile,
        final: baseline,
        candidates,
        screen: screenIds,
        verdict: `Found a promising profile (${describeProfileDiff(baselineProfile, best).join(", ")}) but there was no budget left to confirm it against a fresh baseline on the full suite, so it was not adopted.`,
      });
    }
    options.onProgress?.({ type: "confirm-start", runs: 2 * options.tasks.length * trials });
    // Fresh runs of BOTH profiles: the screen was picked from the first baseline's failures,
    // so comparing against that run would flatter any change (regression to the mean).
    const confirmed = await evaluate(best, options.tasks, "confirm");
    const remeasured = await evaluate(baselineProfile, options.tasks, "confirm-baseline");
    const { fixed, broke } = diffTasks(remeasured, confirmed);
    const improved =
      confirmed.passes > remeasured.passes ||
      (confirmed.passes === remeasured.passes && confirmed.medianToolCalls <= remeasured.medianToolCalls * 0.85 && fixed.length >= broke.length);
    if (!improved) {
      return finish({
        finalProfile: baselineProfile,
        final: remeasured,
        baseline: remeasured,
        candidates,
        screen: screenIds,
        verdict: `The best screen candidate (${describeProfileDiff(baselineProfile, best).join(", ")}) did not hold up against a fresh baseline on the full suite (${confirmed.passes}/${confirmed.runs} vs ${remeasured.passes}/${remeasured.runs}); keeping the defaults.`,
      });
    }
    const p = signTestP(fixed.length, broke.length);
    return finish({
      finalProfile: best,
      final: confirmed,
      baseline: remeasured,
      improved: true,
      candidates,
      screen: screenIds,
      verdict:
        p < 0.1
          ? `Confirmed against a fresh baseline: ${remeasured.passes}/${remeasured.runs} → ${confirmed.passes}/${confirmed.runs}.`
          : `Better than a fresh baseline (${remeasured.passes}/${remeasured.runs} → ${confirmed.passes}/${confirmed.runs}), but with this few tasks the difference could be chance (sign test p=${p.toFixed(2)}). Re-run with more --trials to firm it up.`,
    });
  }

  function evaluateOnScreenFromBaseline(base: Evaluation, tasks: DynoTask[]): Promise<Evaluation> {
    // The baseline already ran these tasks; reuse those numbers instead of paying twice.
    const perTask: Evaluation["perTask"] = new Map();
    for (const task of tasks) {
      const entry = base.perTask.get(task.id);
      if (entry) perTask.set(task.id, entry);
    }
    const passes = [...perTask.values()].reduce((n, e) => n + e.passes, 0);
    const runs = [...perTask.values()].reduce((n, e) => n + e.runs, 0);
    return Promise.resolve({
      profile: base.profile,
      perTask,
      passes,
      runs,
      score: runs ? passes / runs : 0,
      medianToolCalls: median([...perTask.values()].flatMap((e) => e.toolCalls)),
      meanTokens: mean([...perTask.values()].flatMap((e) => e.tokens)),
    });
  }
}

/** Candidate values for a knob, excluding the current one (and unimplemented edit modes). */
export function alternatives(knob: TunableKnob, current: HarnessProfile, editModes: readonly EditMode[]): unknown[] {
  const space = PROFILE_SEARCH_SPACE[knob] as readonly unknown[];
  return space.filter((value) => {
    if (value === current[knob]) return false;
    if (knob === "editMode") return editModes.includes(value as EditMode);
    return true;
  });
}

function diffTasks(a: Evaluation, b: Evaluation): { fixed: string[]; broke: string[] } {
  const fixed: string[] = [];
  const broke: string[] = [];
  for (const [id, after] of b.perTask) {
    const before = a.perTask.get(id);
    if (!before) continue;
    if (after.passes > before.passes) fixed.push(id);
    else if (after.passes < before.passes) broke.push(id);
  }
  return { fixed, broke };
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}
