/**
 * Human- and share-friendly output for Dyno runs.
 */

import { describeProfileDiff } from "../harness/profile.js";
import type { Evaluation, TuneEvent, TuneResult } from "./tuner.js";
import { percent } from "./tuner.js";
import type { DynoTask } from "./types.js";

export interface CardMeta {
  provider: string;
  model: string;
  suite: string;
  tasks: DynoTask[];
  trials: number;
}

/** A markdown "lift card" — small enough to paste into a PR, issue, or chat. */
export function renderLiftCard(result: TuneResult, meta: CardMeta): string {
  const { baseline, final } = result;
  const points = Math.round((final.score - baseline.score) * 100);
  const lines: string[] = [];

  lines.push(`## Dyno — \`${meta.provider}/${meta.model}\``);
  lines.push("");
  if (result.improved) {
    lines.push(
      `**${percent(baseline.score)} → ${percent(final.score)}** on ${meta.tasks.length} tasks × ${meta.trials} trial${meta.trials === 1 ? "" : "s"} (${points >= 0 ? "+" : ""}${points} pts)`,
    );
    lines.push("");
    lines.push(`Tuned: ${result.changes.map((c) => `\`${c}\``).join(" · ")}`);
  } else {
    lines.push(`**${percent(baseline.score)}** on ${meta.tasks.length} tasks × ${meta.trials} trial${meta.trials === 1 ? "" : "s"} — defaults kept.`);
  }
  lines.push("");
  lines.push(result.verdict);

  if (result.fixed.length > 0 || result.broke.length > 0) {
    lines.push("");
    if (result.fixed.length > 0) lines.push(`- Fixed: ${result.fixed.join(", ")}`);
    if (result.broke.length > 0) lines.push(`- Regressed: ${result.broke.join(", ")}`);
    lines.push(`- Sign test p = ${result.pValue.toFixed(3)} (${result.fixed.length} fixed vs ${result.broke.length} regressed)`);
  }

  const cats = categoryTable(baseline, final, meta.tasks);
  if (cats.length > 0) {
    lines.push("", "| Category | Baseline | Tuned |", "| --- | --- | --- |", ...cats);
  }

  if (result.candidates.length > 0) {
    lines.push("", `<details><summary>Search log (${result.candidates.length} candidates on a ${result.screen.length}-task screen)</summary>`, "");
    lines.push("| Change | Screen | Median tool calls | Decision |", "| --- | --- | --- | --- |");
    for (const c of result.candidates) {
      lines.push(`| \`${c.knob}=${String(c.value)}\` | ${c.screenPasses}/${c.screenRuns} | ${c.medianToolCalls} | ${c.accepted ? "✔ kept" : "✘"} ${c.reason} |`);
    }
    lines.push("", "</details>");
  }

  const mins = Math.max(1, Math.round(result.elapsedMs / 60000));
  lines.push(
    "",
    `<sub>${result.runsSpent}/${result.budget} runs · ${formatTokens(result.tokens.input)} in / ${formatTokens(result.tokens.output)} out tokens · ${mins} min · RevCode Dyno, suite: ${meta.suite}</sub>`,
  );
  return lines.join("\n");
}

function categoryTable(a: Evaluation, b: Evaluation, tasks: DynoTask[]): string[] {
  const categories = [...new Set(tasks.map((t) => t.category))];
  return categories.map((category) => {
    const ids = tasks.filter((t) => t.category === category).map((t) => t.id);
    const sum = (e: Evaluation): string => {
      let passes = 0;
      let runs = 0;
      for (const id of ids) {
        const entry = e.perTask.get(id);
        if (entry) {
          passes += entry.passes;
          runs += entry.runs;
        }
      }
      return `${passes}/${runs}`;
    };
    return `| ${category} | ${sum(a)} | ${sum(b)} |`;
  });
}

/** One concise progress line per interesting event (undefined = stay quiet). */
export function formatTuneProgress(event: TuneEvent): string | undefined {
  switch (event.type) {
    case "baseline-start":
      return `Baseline: running ${event.runs} task attempt${event.runs === 1 ? "" : "s"} with the default harness…`;
    case "run":
      return `  [${event.done}/${event.total}] ${event.passed ? "✔" : "✘"} ${event.task}  (${event.knob})`;
    case "baseline-done":
      return `Baseline: ${event.evaluation.passes}/${event.evaluation.runs} passed (${percent(event.evaluation.score)}), median ${event.evaluation.medianToolCalls} tool calls.`;
    case "candidate":
      return `→ ${event.knob}=${String(event.value)}: ${event.evaluation.passes}/${event.evaluation.runs} on the screen — ${event.accepted ? "kept" : "dropped"} (${event.reason})`;
    case "confirm-start":
      return `Confirming the winner against a fresh baseline (${event.runs} runs)…`;
    case "done":
      return undefined;
  }
}

export function formatDryRun(tasks: DynoTask[], trials: number, budget: number, editModes: readonly string[]): string[] {
  const perFull = tasks.length * trials;
  // Baseline + confirm (two full suites) are fixed costs; every candidate then costs one screen.
  const screenGuess = Math.min(tasks.length, Math.max(4, Math.ceil(tasks.length / 2))) * trials;
  const fixed = perFull + 2 * perFull;
  const candidates = Math.max(0, Math.floor((budget - fixed) / screenGuess));
  const lines = [
    `Suite: ${tasks.length} task(s) × ${trials} trial(s) = ${perFull} run(s) per full evaluation.`,
    `Edit modes in play: ${editModes.join(", ")}`,
    "Plan:",
    `  1. Baseline with the default profile: ${perFull} runs (stops here if the model already passes ≥95%).`,
    `  2. Try one knob at a time on a screen of ~${screenGuess} run(s) per candidate (the failed tasks plus a few passing ones).`,
    `  3. Confirm the winner against a fresh baseline: ${2 * perFull} runs.`,
    `Budget: ${budget} runs → roughly ${candidates} candidate(s) can be tried after the ${fixed} fixed runs.`,
  ];
  if (candidates < 6) {
    lines.push(`  ! That is a thin search (about 11 candidates exist). Raise --budget to ~${fixed + 11 * screenGuess} for a full pass.`);
  }
  lines.push(`Tasks: ${tasks.map((t) => t.id).join(", ")}`, "No model calls were made (--dry-run).");
  return lines;
}

function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export { describeProfileDiff };
