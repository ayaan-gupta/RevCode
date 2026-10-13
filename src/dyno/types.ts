/**
 * Dyno task contract.
 *
 * A Dyno task is a tiny, self-contained, DETERMINISTICALLY graded coding job. The
 * runner sets it up in a fresh temp directory, lets the agent work with a given
 * harness profile, and grades the resulting directory with plain code — no LLM
 * in the grading loop. Every task also ships an `oracle` (a reference solution)
 * so the suite can prove itself: the grader must fail on the untouched setup and
 * pass after the oracle runs.
 */

export type DynoCategory = "edit" | "bugfix" | "implement" | "shell" | "refactor" | "multi-step";

export interface GradeResult {
  passed: boolean;
  /** Human-readable reason (shown in reports when a task fails). */
  detail: string;
}

export interface DynoTask {
  /** kebab-case, unique. */
  id: string;
  title: string;
  category: DynoCategory;
  /** 1 = easy … 3 = hard. */
  difficulty: 1 | 2 | 3;
  /** The user message the agent receives. Paths are relative to the task directory. */
  instruction: string;
  /** Iteration budget for the agent loop. */
  maxIterations: number;
  /** Wall-clock budget for the whole attempt, in seconds. */
  timeoutSec: number;
  /** Populate a fresh, empty directory with the task's starting files. */
  setup(dir: string): Promise<void> | void;
  /** Inspect the directory after the attempt. Must be deterministic and side-effect free. */
  grade(dir: string): Promise<GradeResult> | GradeResult;
  /** Reference solution applied directly to the filesystem (used to validate the task). */
  oracle(dir: string): Promise<void> | void;
}
