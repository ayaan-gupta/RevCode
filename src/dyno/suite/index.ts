/**
 * The built-in Dyno task suite.
 *
 * Sixteen small, deterministically graded tasks chosen to separate harness
 * settings from each other rather than to measure raw model skill: six probe edit
 * mechanics (large files, escaping, line endings, ambiguous matches, indentation,
 * multi-file renames), the rest cover bugfixing, implementing from a spec, shell
 * work and multi-step workflows. Roughly half are meant to be hard enough that a
 * mid-tier model does not ace the whole suite.
 */

import type { DynoCategory, DynoTask } from "../types.js";
import { bugfixSharedStateCart } from "./tasks/bugfix-cart.js";
import { bugfixIntervalScheduler } from "./tasks/bugfix-intervals.js";
import { bugfixOrderTotals } from "./tasks/bugfix-order-totals.js";
import { editBigFileConstant } from "./tasks/edit-big-file.js";
import { editCrlfPreserve } from "./tasks/edit-crlf.js";
import { editNearIdenticalBlocks } from "./tasks/edit-near-identical.js";
import { editNestedIndentation } from "./tasks/edit-nested-indent.js";
import { editTrickyCharacters } from "./tasks/edit-tricky-chars.js";
import { implementExpressionEvaluator } from "./tasks/implement-calc.js";
import { implementCsvAggregator } from "./tasks/implement-csv-aggregator.js";
import { implementLruCache } from "./tasks/implement-lru.js";
import { multiStepGitFeatureBranch } from "./tasks/multi-git-branch.js";
import { multiStepServeManifest } from "./tasks/multi-serve-manifest.js";
import { refactorRenameFunction } from "./tasks/refactor-rename.js";
import { shellBatchCsvScript } from "./tasks/shell-batch-script.js";
import { shellLogIncidentSearch } from "./tasks/shell-log-search.js";

export const BUILTIN_SUITE: DynoTask[] = [
  // Edit robustness
  editBigFileConstant,
  editTrickyCharacters,
  editCrlfPreserve,
  editNearIdenticalBlocks,
  editNestedIndentation,
  refactorRenameFunction,
  // Bugfix
  bugfixOrderTotals,
  bugfixIntervalScheduler,
  bugfixSharedStateCart,
  // Implement from a spec
  implementCsvAggregator,
  implementExpressionEvaluator,
  implementLruCache,
  // Shell and multi-step
  shellBatchCsvScript,
  multiStepServeManifest,
  multiStepGitFeatureBranch,
  shellLogIncidentSearch,
];

/**
 * Tasks that bind a fixed TCP port and whose grader kills whatever listens on it.
 * Two attempts at one of these must never overlap, so a runner with concurrency
 * above 1 has to run them one at a time.
 */
export const SERIAL_TASK_IDS: ReadonlySet<string> = new Set([multiStepServeManifest.id]);

export function getTask(id: string): DynoTask | undefined {
  return BUILTIN_SUITE.find((task) => task.id === id);
}

/**
 * Pick tasks by id and/or category, always returned in suite order. When both
 * filters are given a task must match both. An empty or missing filter selects
 * everything. Unknown ids throw: silently dropping a typo would quietly shrink a
 * benchmark and skew its score.
 */
export function selectTasks(ids?: readonly string[], categories?: readonly DynoCategory[]): DynoTask[] {
  const wantedIds = ids && ids.length > 0 ? new Set(ids) : undefined;
  const wantedCategories = categories && categories.length > 0 ? new Set(categories) : undefined;

  if (wantedIds) {
    const known = new Set(BUILTIN_SUITE.map((task) => task.id));
    const unknown = [...wantedIds].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown Dyno task id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    }
  }

  return BUILTIN_SUITE.filter(
    (task) => (!wantedIds || wantedIds.has(task.id)) && (!wantedCategories || wantedCategories.has(task.category)),
  );
}
