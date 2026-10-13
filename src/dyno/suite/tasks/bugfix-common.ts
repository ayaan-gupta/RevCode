/**
 * Shared grader for the bugfix tasks.
 *
 * The tests are the specification, so the agent must not "fix" them: every
 * protected test file is hashed against its pristine content, and a modified or
 * deleted file fails the task outright. The pristine tests are then run in a
 * scratch copy together with a private check script that probes the source with
 * inputs the visible tests never use, so special-casing the test data does not
 * pay either.
 */

import type { GradeResult } from "../../types.js";
import { clip, fail, failingTests, parseUnittest, pass, python, pythonCode, readText, sha256, withScratchCopy } from "../helpers.js";

export interface BugfixSpec {
  /** Pristine test files: path relative to the task directory -> exact content. */
  tests: Readonly<Record<string, string>>;
  /** Dotted unittest module names to run, e.g. `tests.test_orders`. */
  modules: readonly string[];
  /** Number of tests those modules contain; fewer means tests were removed or skipped. */
  expectedTests: number;
  /** Private Python checks: must exit 0 and print HIDDEN-OK. */
  hiddenChecks: string;
}

export async function gradeBugfix(dir: string, spec: BugfixSpec): Promise<GradeResult> {
  for (const [relative, pristine] of Object.entries(spec.tests)) {
    const actual = readText(dir, relative);
    if (actual === undefined) return fail(`${relative} was deleted; the tests must stay in place`);
    if (sha256(actual) !== sha256(pristine)) return fail(`${relative} was modified; fix the source, not the tests`);
  }

  return withScratchCopy(dir, async (scratch) => {
    const tests = await python(["-m", "unittest", ...spec.modules], { cwd: scratch, timeoutMs: 30_000 });
    if (tests.timedOut) return fail("the test run timed out (infinite loop?)");
    const summary = parseUnittest(tests.stderr);
    if (!summary) return fail(`the tests did not run: ${clip(tests.stderr, 600)}`);
    if (summary.ran !== spec.expectedTests) return fail(`${summary.ran} tests ran, expected ${spec.expectedTests}`);
    if (!summary.ok || tests.code !== 0) {
      const names = failingTests(tests.stderr);
      return fail(`${names.length} tests still failing: ${names.slice(0, 6).join(", ")}`);
    }

    const hidden = await pythonCode(spec.hiddenChecks, { cwd: scratch, timeoutMs: 30_000 });
    if (hidden.timedOut) return fail("the extra behaviour checks timed out");
    if (hidden.code !== 0 || !hidden.stdout.includes("HIDDEN-OK")) {
      const lines = hidden.stderr.trim().split("\n");
      return fail(`visible tests pass, but extra behaviour checks fail: ${clip(lines.slice(-3).join(" | "), 500)}`);
    }
    return pass(`${summary.ran} tests pass and extra checks hold`);
  });
}
