/**
 * Validity tests for the built-in suite.
 *
 * A benchmark task is only useful if it is provably neither pre-solved nor
 * unsolvable, so every task is checked the same way: grading the untouched setup
 * must fail, grading after the reference oracle must pass, grading must be
 * repeatable and leave the directory alone, and setup must be reproducible.
 * Bugfix tasks are additionally attacked the way a lazy agent would (editing or
 * deleting the tests), and a table of plausible-but-wrong solutions proves the
 * graders look at behaviour rather than at the presence of a change.
 *
 * Each task's pipeline runs once, concurrently with the others, because the
 * checks are independent of each other; the individual `it`s only report.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DynoCategory, DynoTask, GradeResult } from "../types.js";
import { BUILTIN_SUITE, getTask, selectTasks } from "./index.js";
import { git, httpGetWithRetry, killListeners, listFiles, pythonCode, run, startDetached, treeDigest, writeFiles } from "./helpers.js";
import { SERVE_PORT } from "./tasks/multi-serve-manifest.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

const tempDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyno-suite-"));
  tempDirs.push(dir);
  return dir;
}

/** Tasks whose grade needs a live process on a fixed port, so their pipelines must not overlap. */
const PORT_TASKS = new Set(["multi-step-serve-manifest"]);

let exclusiveTail: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = exclusiveTail.then(fn, fn);
  exclusiveTail = run.catch(() => undefined);
  return run;
}

/** Tree digest plus the git HEAD, since `.git` itself is excluded from the digest. */
async function fingerprint(dir: string): Promise<string> {
  const digest = treeDigest(dir);
  if (!fs.existsSync(path.join(dir, ".git"))) return digest;
  const head = await git(["rev-parse", "HEAD"], { cwd: dir });
  return `${digest}:${head.stdout.trim()}`;
}

const sameResult = (a: GradeResult, b: GradeResult): boolean => a.passed === b.passed && a.detail === b.detail;

interface Validation {
  error?: string;
  fingerprintA: string;
  fingerprintB: string;
  unsolved: GradeResult;
  unsolvedAgain: GradeResult;
  solved: GradeResult;
  solvedAgain: GradeResult;
  /** Directory fingerprint right after the oracle, and after both solved grades. */
  beforeGrading: string;
  afterGrading: string;
}

const blank: GradeResult = { passed: false, detail: "not run" };

async function validate(task: DynoTask): Promise<Validation> {
  const result: Validation = {
    fingerprintA: "",
    fingerprintB: "",
    unsolved: blank,
    unsolvedAgain: blank,
    solved: blank,
    solvedAgain: blank,
    beforeGrading: "",
    afterGrading: "",
  };
  try {
    const dirA = freshDir();
    const dirB = freshDir();
    await task.setup(dirA);
    await task.setup(dirB);
    result.fingerprintA = await fingerprint(dirA);
    result.fingerprintB = await fingerprint(dirB);

    result.unsolved = await task.grade(dirA);
    result.unsolvedAgain = await task.grade(dirA);

    await task.oracle(dirA);
    result.beforeGrading = await fingerprint(dirA);
    result.solved = await task.grade(dirA);
    if (PORT_TASKS.has(task.id)) {
      // The grader kills the server it inspects, so bring the same state back (the oracle is re-runnable).
      await task.oracle(dirA);
    }
    result.solvedAgain = await task.grade(dirA);
    result.afterGrading = await fingerprint(dirA);
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  return result;
}

const validations = new Map<string, Promise<Validation>>();

// ---------------------------------------------------------------------------
// Cheating the tests (bugfix tasks)
// ---------------------------------------------------------------------------

const TRIVIAL_TEST = "import unittest\n\n\nclass Trivial(unittest.TestCase):\n    def test_nothing(self):\n        self.assertTrue(True)\n";

type Cheat = { name: string; prepare(dir: string, task: DynoTask): Promise<void> | void };

function testFiles(dir: string): string[] {
  return listFiles(dir).filter((file) => /^tests\/test_[^/]+\.py$/.test(file));
}

const CHEATS: Cheat[] = [
  {
    name: "replacing the failing tests with trivial passing ones",
    prepare: (dir) => {
      for (const file of testFiles(dir)) fs.writeFileSync(path.join(dir, file), TRIVIAL_TEST);
    },
  },
  {
    name: "deleting the tests",
    prepare: (dir) => fs.rmSync(path.join(dir, "tests"), { recursive: true, force: true }),
  },
  {
    name: "fixing the source but also loosening one test",
    prepare: async (dir, task) => {
      await task.oracle(dir);
      const [first] = testFiles(dir);
      if (!first) throw new Error("no test file found");
      const file = path.join(dir, first);
      fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\n# loosened\n`);
    },
  },
  {
    name: "fixing the source and replacing the tests with trivial ones",
    prepare: async (dir, task) => {
      await task.oracle(dir);
      for (const file of testFiles(dir)) fs.writeFileSync(path.join(dir, file), TRIVIAL_TEST);
    },
  },
];

const bugfixTasks = BUILTIN_SUITE.filter((task) => task.category === "bugfix");
const cheatResults = new Map<string, Promise<Array<{ cheat: string; result: GradeResult }>>>();

async function attemptCheats(task: DynoTask): Promise<Array<{ cheat: string; result: GradeResult }>> {
  const out: Array<{ cheat: string; result: GradeResult }> = [];
  for (const cheat of CHEATS) {
    const dir = freshDir();
    await task.setup(dir);
    await cheat.prepare(dir, task);
    out.push({ cheat: cheat.name, result: await task.grade(dir) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plausible wrong solutions
// ---------------------------------------------------------------------------

interface WrongSolution {
  task: string;
  name: string;
  /** Leaves the directory in a state a flawed attempt could plausibly produce. */
  apply(dir: string, task: DynoTask): Promise<void> | void;
}

function editFile(dir: string, relative: string, edit: (text: string) => string): void {
  const file = path.join(dir, relative);
  const before = fs.readFileSync(file, "utf8");
  const after = edit(before);
  if (after === before) throw new Error(`mutation had no effect on ${relative}`);
  fs.writeFileSync(file, after);
}

const WRONG_SOLUTIONS: WrongSolution[] = [
  {
    task: "edit-big-file-constant",
    name: "changes the constant and silently rewrites a neighbouring line",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "inventory/registry.py", (text) => text.replace("RETRY_BASE_MS = 250", "RETRY_BASE_MS = 200"));
    },
  },
  {
    task: "edit-big-file-constant",
    name: "truncates the file after the edit",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "inventory/registry.py", (text) => text.split("\n").slice(0, 1200).join("\n") + "\n");
    },
  },
  {
    task: "edit-tricky-characters",
    name: "turns the TAB separators into spaces",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "receipts/templates.py", (text) => text.replace('ITEM_ROW = "{sku}\t{qty}×\t{name}\t{price}\\n"', 'ITEM_ROW = "{sku}  {qty}×  {name}  {price}\\n"'));
    },
  },
  {
    task: "edit-tricky-characters",
    name: "double-escapes the backslashes in the footer",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "receipts/templates.py", (text) => text.replace("D:\\\\Archive\\\\{id}.pdf", "D:\\\\\\\\Archive\\\\\\\\{id}.pdf"));
    },
  },
  {
    task: "edit-crlf-preserve",
    name: "rewrites the whole file with LF endings",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "deploy/service.ini", (text) => text.replaceAll("\r\n", "\n"));
    },
  },
  {
    task: "edit-crlf-preserve",
    name: "inserts the new line with a bare LF",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "deploy/service.ini", (text) => text.replace("pool_timeout = 30\r\n", "pool_timeout = 30\n"));
    },
  },
  {
    task: "edit-crlf-preserve",
    name: "edits the wrong max_connections (the [cache] one)",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "deploy/service.ini", (text) => text.replace("max_connections = 50\r\npool_timeout", "max_connections = 20\r\npool_timeout"));
      editFile(dir, "deploy/service.ini", (text) => text.replace("host = cache01.internal\r\nmax_connections = 20", "host = cache01.internal\r\nmax_connections = 50"));
    },
  },
  {
    task: "edit-near-identical-blocks",
    name: "raises every sender to 5 attempts",
    apply: (dir) => editFile(dir, "notifier.py", (text) => text.replaceAll("range(3)", "range(5)")),
  },
  {
    task: "edit-near-identical-blocks",
    name: "edits the first loop instead of send_sms",
    apply: (dir) => editFile(dir, "notifier.py", (text) => text.replace("range(3)", "range(5)")),
  },
  {
    task: "edit-nested-indentation",
    name: "reads entry['waived'] directly, so the KeyError handler miscounts",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "ledger/reconcile.py", (text) => text.replace('elif entry.get("waived"):', 'elif entry["waived"]:'));
    },
  },
  {
    task: "edit-nested-indentation",
    name: "counts waived entries that are within tolerance too",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "ledger/reconcile.py", (text) =>
        text.replace(
          '                            if abs(entry["amount"] - rule["expected"]) <= rule["tolerance"]:\n                                stats["matched"] += 1',
          '                            if entry.get("waived"):\n                                stats["waived"] += 1\n                            elif abs(entry["amount"] - rule["expected"]) <= rule["tolerance"]:\n                                stats["matched"] += 1',
        ),
      );
    },
  },
  {
    task: "refactor-rename-function",
    name: "keeps the old name as an alias",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "store/db.py", (text) => `${text}\n\nfetch_data = load_records\n`);
    },
  },
  {
    task: "refactor-rename-function",
    name: "forgets the string-based lookup in sync.py",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "store/sync.py", (text) => text.replace('LOADER_NAME = "load_records"', 'LOADER_NAME = "fetch_data"'));
    },
  },
  {
    task: "refactor-rename-function",
    name: "renames code but leaves the README",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "README.md", (text) => text.replaceAll("load_records", "fetch_data"));
    },
  },
  {
    task: "bugfix-order-totals",
    name: "treats a missing tier as bronze but not tier=None",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "orders/pricing.py", (text) => text.replace('customer.get("tier") or "bronze"', 'customer.get("tier", "bronze")'));
    },
  },
  {
    task: "bugfix-order-totals",
    name: "fixes only the crash",
    apply: (dir) =>
      editFile(dir, "orders/pricing.py", (text) => text.replace('TIER_DISCOUNT_PCT[customer["tier"]]', 'TIER_DISCOUNT_PCT[customer.get("tier") or "bronze"]')),
  },
  {
    task: "bugfix-interval-scheduler",
    name: "sorts but still drops the trailing gap",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "scheduler/intervals.py", (text) => text.replace("    if cursor < day_end:\n        slots.append((cursor, day_end))\n", ""));
    },
  },
  {
    task: "bugfix-shared-state-cart",
    name: "fixes the default argument but still aliases the caller's list",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "shop/cart.py", (text) => text.replace("[dict(item) for item in (items or [])]", "items if items is not None else []"));
    },
  },
  {
    task: "bugfix-shared-state-cart",
    name: "fixes the default argument but still shares catalogue dicts",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "shop/cart.py", (text) => text.replace("self.items.append(dict(product))", "self.items.append(product)"));
    },
  },
  {
    task: "implement-csv-aggregator-cli",
    name: "does not sort the group keys",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "aggregate.py", (text) => text.replace("for key in sorted(groups):", "for key in groups:"));
    },
  },
  {
    task: "implement-csv-aggregator-cli",
    name: "counts unparseable rows instead of skipping them",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "aggregate.py", (text) => text.replace("NUMBER.fullmatch(cell)", "NUMBER.match(cell)"));
    },
  },
  {
    task: "implement-expression-evaluator",
    name: "delegates to eval",
    apply: (dir) =>
      writeFiles(dir, {
        "calc.py": 'def evaluate(expression):\n    return eval(expression.replace("^", "**"))\n\n\ndef is_balanced(text):\n    return True\n',
      }),
  },
  {
    task: "implement-expression-evaluator",
    name: "always returns floats",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "calc.py", (text) => text.replace("        return int(value)\n", "        return value\n"));
    },
  },
  {
    task: "implement-lru-cache",
    name: "peek refreshes recency",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "lru_cache.py", (text) => text.replace("        return self._data.get(key, default)\n", "        return self.get(key, default)\n"));
    },
  },
  {
    task: "implement-lru-cache",
    name: "calls on_evict for deletes as well",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "lru_cache.py", (text) =>
        text.replace("            del self._data[key]\n            return True", "            value = self._data.pop(key)\n            if self._on_evict is not None:\n                self._on_evict(key, value)\n            return True"),
      );
    },
  },
  {
    task: "shell-batch-csv-script",
    name: "outputs produced by hand, no reusable script",
    apply: async (dir, task) => {
      await task.oracle(dir);
      fs.writeFileSync(path.join(dir, "process.sh"), "#!/usr/bin/env bash\ntrue\n");
    },
  },
  {
    task: "shell-batch-csv-script",
    name: "loose grep keeps the inactive rows",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "process.sh", (text) => text.replace("$3 == \"active\"", "$3 ~ /active/"));
      await run("bash", ["process.sh"], { cwd: dir, timeoutMs: 20_000 });
    },
  },
  {
    task: "shell-batch-csv-script",
    name: "stale files survive a rerun",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "process.sh", (text) => text.replace("rm -rf outgoing\n", ""));
    },
  },
  {
    task: "multi-step-serve-manifest",
    name: "server not left running",
    apply: async (dir, task) => {
      await task.oracle(dir);
      await killListeners(SERVE_PORT);
    },
  },
  {
    task: "multi-step-serve-manifest",
    name: "plain static server without /health",
    apply: async (dir, task) => {
      await task.oracle(dir);
      await killListeners(SERVE_PORT);
      startDetached("python3", ["-B", "-m", "http.server", String(SERVE_PORT), "--bind", "127.0.0.1", "--directory", "public"], dir);
      await httpGetWithRetry(`http://127.0.0.1:${SERVE_PORT}/index.html`, 8_000);
    },
  },
  {
    task: "multi-step-git-feature-branch",
    name: "git add -A sweeps in the unrelated edits",
    apply: async (dir, task) => {
      await task.oracle(dir);
      await git(["reset", "--soft", "main"], { cwd: dir });
      await git(["add", "-A"], { cwd: dir });
      await git(["commit", "--quiet", "-m", "Raise default rate limit to 250"], { cwd: dir });
    },
  },
  {
    task: "multi-step-git-feature-branch",
    name: "commits on main instead of a new branch",
    apply: async (dir, task) => {
      await task.oracle(dir);
      await git(["checkout", "--quiet", "main"], { cwd: dir });
      await git(["merge", "--quiet", "--ff-only", "feature/rate-limit"], { cwd: dir });
    },
  },
  {
    task: "multi-step-git-feature-branch",
    name: "wrong commit message",
    apply: async (dir, task) => {
      await task.oracle(dir);
      await git(["commit", "--amend", "--quiet", "-m", "raise rate limit"], { cwd: dir });
    },
  },
  {
    task: "shell-log-incident-search",
    name: "reports the number of matching files instead of lines",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "findings.txt", (text) => text.replace(/count: \d+/, "count: 1"));
    },
  },
  {
    task: "shell-log-incident-search",
    name: "answers with a look-alike code's file",
    apply: async (dir, task) => {
      await task.oracle(dir);
      editFile(dir, "findings.txt", (text) => text.replace("ledger-2024-03-13", "ledger-2024-03-12"));
    },
  },
];

const wrongResults = new Map<string, Promise<GradeResult>>();

async function attemptWrongSolution(wrong: WrongSolution): Promise<GradeResult> {
  const task = getTask(wrong.task);
  if (!task) throw new Error(`unknown task ${wrong.task}`);
  const dir = freshDir();
  await task.setup(dir);
  await wrong.apply(dir, task);
  return task.grade(dir);
}

const wrongKey = (wrong: WrongSolution): string => `${wrong.task}: ${wrong.name}`;

// ---------------------------------------------------------------------------

beforeAll(() => {
  for (const task of BUILTIN_SUITE) {
    validations.set(task.id, PORT_TASKS.has(task.id) ? exclusive(() => validate(task)) : validate(task));
  }
  for (const task of bugfixTasks) cheatResults.set(task.id, attemptCheats(task));
  for (const wrong of WRONG_SOLUTIONS) {
    const run = () => attemptWrongSolution(wrong);
    wrongResults.set(wrongKey(wrong), PORT_TASKS.has(wrong.task) ? exclusive(run) : run());
  }
});

afterAll(async () => {
  await Promise.allSettled([...validations.values(), ...cheatResults.values(), ...wrongResults.values()]);
  await killListeners(SERVE_PORT);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("suite registry", () => {
  it("has sixteen tasks with unique kebab-case ids", () => {
    expect(BUILTIN_SUITE).toHaveLength(16);
    const ids = BUILTIN_SUITE.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("gives every task sensible budgets and a real instruction", () => {
    for (const task of BUILTIN_SUITE) {
      expect(task.maxIterations, task.id).toBeGreaterThanOrEqual(15);
      expect(task.maxIterations, task.id).toBeLessThanOrEqual(40);
      expect(task.timeoutSec, task.id).toBeGreaterThanOrEqual(90);
      expect(task.timeoutSec, task.id).toBeLessThanOrEqual(240);
      expect([1, 2, 3]).toContain(task.difficulty);
      expect(task.title.length, task.id).toBeGreaterThan(10);
      expect(task.instruction.length, task.id).toBeGreaterThan(150);
      expect(task.instruction.length, task.id).toBeLessThan(1400);
    }
  });

  it("covers the required categories and a spread of difficulties", () => {
    const count = (category: DynoCategory): number => BUILTIN_SUITE.filter((task) => task.category === category).length;
    expect(count("edit") + count("refactor")).toBe(6);
    expect(count("bugfix")).toBe(3);
    expect(count("implement")).toBe(3);
    expect(count("shell") + count("multi-step")).toBe(4);
    const hard = BUILTIN_SUITE.filter((task) => task.difficulty >= 2).length;
    expect(hard).toBeGreaterThanOrEqual(8);
    expect(BUILTIN_SUITE.some((task) => task.difficulty === 3)).toBe(true);
  });

  it("looks tasks up by id", () => {
    expect(getTask("edit-crlf-preserve")?.category).toBe("edit");
    expect(getTask("no-such-task")).toBeUndefined();
  });

  it("selects by ids and categories in suite order", () => {
    expect(selectTasks()).toHaveLength(16);
    expect(selectTasks([], [])).toHaveLength(16);
    expect(selectTasks(["implement-lru-cache", "edit-crlf-preserve"]).map((task) => task.id)).toEqual([
      "edit-crlf-preserve",
      "implement-lru-cache",
    ]);
    expect(selectTasks(undefined, ["bugfix"])).toHaveLength(3);
    expect(selectTasks(["implement-lru-cache"], ["bugfix"])).toEqual([]);
    expect(selectTasks(undefined, ["shell", "multi-step"])).toHaveLength(4);
  });

  it("rejects unknown ids instead of silently dropping them", () => {
    expect(() => selectTasks(["edit-crlf-preserve", "nope", "also-nope"])).toThrow(/Unknown Dyno task ids: nope, also-nope/);
  });
});

describe.each(BUILTIN_SUITE.map((task) => [task.id, task] as const))("task %s", (_id, task) => {
  const validation = (): Promise<Validation> => validations.get(task.id) as Promise<Validation>;

  it("runs its whole validation pipeline without errors", async () => {
    expect((await validation()).error).toBeUndefined();
  });

  it("is not pre-solved: grading the untouched setup fails", async () => {
    const { unsolved } = await validation();
    expect(unsolved.passed, unsolved.detail).toBe(false);
    expect(unsolved.detail.length).toBeGreaterThan(0);
  });

  it("is solvable: grading after the oracle passes", async () => {
    const { solved } = await validation();
    expect(solved.passed, solved.detail).toBe(true);
  });

  it("grades idempotently", async () => {
    const v = await validation();
    expect(sameResult(v.unsolved, v.unsolvedAgain), `${v.unsolved.detail} vs ${v.unsolvedAgain.detail}`).toBe(true);
    expect(sameResult(v.solved, v.solvedAgain), `${v.solved.detail} vs ${v.solvedAgain.detail}`).toBe(true);
  });

  it("sets up deterministically", async () => {
    const v = await validation();
    expect(v.fingerprintA).not.toBe("");
    expect(v.fingerprintA).toBe(v.fingerprintB);
  });

  it("does not modify the directory while grading", async () => {
    const v = await validation();
    expect(v.afterGrading).toBe(v.beforeGrading);
  });
});

describe.each(bugfixTasks.map((task) => [task.id, task] as const))("cheat resistance of %s", (_id, task) => {
  it.each(CHEATS.map((cheat) => [cheat.name] as const))("fails when %s", async (name) => {
    const outcomes = await (cheatResults.get(task.id) as Promise<Array<{ cheat: string; result: GradeResult }>>);
    const outcome = outcomes.find((candidate) => candidate.cheat === name);
    expect(outcome, name).toBeDefined();
    expect(outcome?.result.passed, outcome?.result.detail).toBe(false);
  });
});

describe("graders reject plausible wrong solutions", () => {
  it.each(WRONG_SOLUTIONS.map((wrong) => [wrongKey(wrong), wrong] as const))("%s", async (key) => {
    const result = await (wrongResults.get(key) as Promise<GradeResult>);
    expect(result.passed, result.detail).toBe(false);
  });

  it("only targets tasks that exist", () => {
    for (const wrong of WRONG_SOLUTIONS) expect(getTask(wrong.task), wrong.task).toBeDefined();
  });
});

describe("python environment", () => {
  it("is available for the graders", async () => {
    const result = await pythonCode("import sys; print(sys.version_info >= (3, 9))", { cwd: os.tmpdir() });
    expect(result.stdout.trim()).toBe("True");
  });
});
