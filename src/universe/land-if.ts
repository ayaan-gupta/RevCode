/**
 * `revcode run "<task>" --land-if "<check>"`: the agent works in a private copy;
 * afterwards the check runs in that copy, and the changes are applied to the
 * project only if it passes. Made for scripts, cron jobs and CI.
 *
 * All or nothing: if the project changed underneath in a way that conflicts,
 * nothing is applied. A failed or skipped run keeps the copy for inspection.
 */

import { describeCheck, runCheck, type CheckResult } from "./check.js";
import { applyLand, planLand } from "./land.js";
import type { Universe } from "./universe.js";

export type LandIfStatus = "landed" | "nothing-to-land" | "check-failed" | "conflict" | "not-run";

export interface LandIfOutcome {
  status: LandIfStatus;
  check?: CheckResult;
  /** Files applied to the project (landed) or waiting in the copy (otherwise). */
  files: string[];
  conflicts: string[];
  /** Why the check was not run. */
  reason?: string;
}

export async function landIfPasses(
  universe: Universe,
  command: string,
  options: { stopReason: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<LandIfOutcome> {
  if (options.stopReason === "error" || options.stopReason === "aborted") {
    const files = await universe.changedFiles().catch(() => []);
    return { status: "not-run", files, conflicts: [], reason: options.stopReason === "error" ? "the model request failed" : "the run was interrupted" };
  }

  const check = await runCheck(universe.workDir, command, { timeoutMs: options.timeoutMs, signal: options.signal });
  // Plan after the check: what lands is exactly the state that was checked.
  const plan = await planLand(universe);
  const actionable = plan.items.filter((item) => item.action !== "identical" && item.action !== "already-gone");
  const files = actionable.map((item) => item.path);
  if (!check.passed) {
    return { status: "check-failed", check, files, conflicts: [] };
  }
  if (actionable.length === 0) {
    universe.discard();
    return { status: "nothing-to-land", check, files: [], conflicts: [] };
  }
  const conflicts = actionable.filter((item) => item.action === "conflict").map((item) => item.path);
  if (conflicts.length > 0) {
    return { status: "conflict", check, files, conflicts };
  }
  const result = await applyLand(universe, plan);
  universe.discard();
  return { status: "landed", check, files: [...result.written, ...result.deleted], conflicts: [] };
}

/** Plain-text report for the terminal. */
export function formatLandIf(outcome: LandIfOutcome, universe: Universe, projectRoot: string): string[] {
  const list = (files: string[]): string => (files.length <= 6 ? files.join(", ") : `${files.slice(0, 6).join(", ")} and ${files.length - 6} more`);
  const tail = outcome.check && !outcome.check.passed && outcome.check.tail ? outcome.check.tail.split("\n").map((line) => `    ${line}`) : [];
  const kept = [`  The changes are kept in the copy:`, `    revcode universes diff ${universe.id}`, `    revcode universes land ${universe.id}`];
  const check = outcome.check ? describeCheck(outcome.check) : "";
  switch (outcome.status) {
    case "landed":
      return [`✔ ${check}`, `✔ Applied ${outcome.files.length} file${outcome.files.length === 1 ? "" : "s"} to ${projectRoot}: ${list(outcome.files)}`];
    case "nothing-to-land":
      return [`✔ ${check}`, "Nothing to apply: the task made no changes."];
    case "check-failed":
      return [`✘ ${check}. Nothing was applied.`, ...tail, ...(outcome.files.length ? kept : [])];
    case "conflict":
      return [`✔ ${check}`, `✘ Nothing was applied: your project changed in the meantime and these files conflict: ${list(outcome.conflicts)}`, ...kept];
    case "not-run":
      return [`✘ The check was not run because ${outcome.reason}. Nothing was applied.`, ...(outcome.files.length ? kept : [])];
  }
}
