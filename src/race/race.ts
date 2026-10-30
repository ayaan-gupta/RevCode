/**
 * Race: several attempts at the same task, at the same time, each in its own
 * private copy of the project (optionally on different models). Each result is
 * checked with the project's tests, the attempts are ranked, and the best one
 * can be applied to the project.
 *
 * Every attempt starts from the identical state: one copy is made, and the
 * other attempts are forks of its first checkpoint. All attempts share one
 * spending meter, so `--max-cost` caps the whole race. Checks run one at a time
 * so test suites that bind fixed ports don't trip over each other.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CliArgs } from "../cli.js";
import { createRuntime, type Runtime } from "../agent/setup.js";
import { runTrackedTurn } from "../agent/turn.js";
import type { EngineObserver, StopReason } from "../agent/engine.js";
import { isLlmProvider, resolveProvider, type LlmClient, type LlmProvider } from "../llm/client.js";
import { SpendMeter } from "../llm/spend.js";
import { runCheck, type CheckResult } from "../universe/check.js";
import type { Receipt } from "../universe/receipts.js";
import { Universe } from "../universe/universe.js";

export interface AttemptSpec {
  n: number;
  model: string;
  provider: LlmProvider;
}

export type AttemptStatus = "waiting" | "working" | "checking" | "done";

export interface Attempt {
  spec: AttemptSpec;
  status: AttemptStatus;
  universe?: Universe;
  startedAt?: number;
  endedAt?: number;
  steps: number;
  /** What it is doing right now ("edit_file src/a.ts", "npm test"). */
  activity?: string;
  costUsd: number;
  stopReason?: StopReason;
  error?: string;
  receipt?: Receipt;
  finalMessage?: string;
  files: number;
  insertions: number;
  deletions: number;
  check?: CheckResult;
  /** Hash of the resulting files: attempts with equal hashes produced identical code. */
  tree?: string;
}

export interface RaceOptions {
  task: string;
  args: CliArgs;
  attempts: AttemptSpec[];
  /** Command that decides whether an attempt succeeded (tests, build). */
  check?: string;
  /** How many attempts work at once (default: all). */
  parallel?: number;
  spend?: SpendMeter;
  signal?: AbortSignal;
  /** Called whenever an attempt's state changes (live display). */
  onUpdate?: (attempts: readonly Attempt[]) => void;
  warn?: (message: string) => void;
  /** Inject model clients (tests). */
  llmFor?: (spec: AttemptSpec) => LlmClient | undefined;
}

export interface RaceResult {
  attempts: Attempt[];
  /** Best first. */
  ranked: Attempt[];
  /** The attempt worth applying, if any qualifies. */
  winner?: Attempt;
  spentUsd: number;
}

export async function runRace(options: RaceOptions): Promise<RaceResult> {
  const { args, task } = options;
  const spend = options.spend ?? new SpendMeter(args.maxCost);
  const attempts: Attempt[] = options.attempts.map((spec) => ({ spec, status: "waiting", steps: 0, costUsd: 0, files: 0, insertions: 0, deletions: 0 }));
  const update = (): void => options.onUpdate?.(attempts);
  const seen = new Set<string>();
  const warn = (message: string): void => {
    if (seen.has(message)) return;
    seen.add(message);
    options.warn?.(message);
  };

  // One copy, then forks of its starting point: every attempt begins from the same files.
  const first = options.attempts[0];
  const base = await Universe.create({ projectRoot: args.cwd, provider: first.provider, model: first.model, name: raceName(1, task) });
  attempts[0].universe = base;
  for (const attempt of attempts.slice(1)) {
    const fork = await base.fork(1, { name: raceName(attempt.spec.n, task) });
    fork.setModel(attempt.spec.provider, attempt.spec.model);
    attempt.universe = fork;
  }
  update();

  let checkQueue: Promise<unknown> = Promise.resolve();
  const runOne = async (attempt: Attempt): Promise<void> => {
    const universe = attempt.universe!;
    attempt.status = "working";
    attempt.startedAt = Date.now();
    update();
    let runtime: Runtime | undefined;
    try {
      if (options.signal?.aborted) throw new Error("stopped");
      runtime = await createRuntime({
        args: { ...args, model: attempt.spec.model, provider: attempt.spec.provider, headless: true, universe: true },
        interactive: false,
        universe,
        spend,
        llm: options.llmFor?.(attempt.spec),
        observer: attemptObserver(attempt, update, () => runtime?.costUsd()),
        warn,
        task,
      });
      const rt = runtime;
      const stopShells = (): void => rt.tools.interruptShell();
      options.signal?.addEventListener("abort", stopShells, { once: true });
      try {
        const before = rt.engine.messages.length;
        const { result, receipt } = await runTrackedTurn(rt, task, { signal: options.signal });
        attempt.stopReason = result.stopReason;
        attempt.error = result.error;
        attempt.receipt = receipt;
        // The agent's first final answer is its summary; later ones answer the completion audit.
        const answers = rt.engine.messages.slice(before).filter((m) => m.role === "assistant" && !(m.toolCalls?.length) && m.content.trim());
        attempt.finalMessage = answers[0]?.content ?? result.finalContent;
      } finally {
        options.signal?.removeEventListener("abort", stopShells);
      }
      attempt.costUsd = rt.costUsd();
    } catch (error) {
      attempt.stopReason = options.signal?.aborted ? "aborted" : "error";
      attempt.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (runtime) {
        attempt.costUsd = runtime.costUsd();
        await runtime.dispose();
      }
    }
    attempt.activity = undefined;
    try {
      const stat = await universe.diffStat();
      attempt.files = stat.files;
      attempt.insertions = stat.insertions;
      attempt.deletions = stat.deletions;
      attempt.tree = await universe.treeSha();
    } catch {
      // the copy is unreadable: it can't win
    }

    if (options.check && !options.signal?.aborted && attempt.stopReason !== "error") {
      attempt.status = "checking";
      attempt.activity = "waiting for another attempt's check to finish";
      update();
      // One check at a time: test suites often bind fixed ports or share caches.
      const turn = checkQueue.then(() => {
        if (options.signal?.aborted) return undefined;
        attempt.activity = options.check;
        update();
        return runCheck(universe.workDir, options.check!, { signal: options.signal });
      });
      checkQueue = turn.catch(() => undefined);
      attempt.check = await turn;
      attempt.activity = undefined;
    }
    attempt.status = "done";
    attempt.endedAt = Date.now();
    update();
  };

  await pool(attempts, Math.max(1, options.parallel ?? attempts.length), runOne);
  const ranked = rankAttempts(attempts, Boolean(options.check));
  const winner = ranked[0] && qualifies(ranked[0], Boolean(options.check)) ? ranked[0] : undefined;
  return { attempts, ranked, winner, spentUsd: spend.spentUsd };
}

function attemptObserver(attempt: Attempt, update: () => void, cost: () => number | undefined): EngineObserver {
  return {
    toolCall: (call) => {
      attempt.steps += 1;
      attempt.costUsd = cost() ?? attempt.costUsd;
      const detail = String(call.arguments.command ?? call.arguments.path ?? call.arguments.pattern ?? "").replace(/\s+/g, " ");
      attempt.activity = `${call.name}${detail ? ` ${detail}` : ""}`;
      update();
    },
  };
}

/**
 * Did this attempt produce something worth applying? It changed files, and with
 * a check the check passed; without one, its own last test run (after its last
 * edit) passed.
 */
export function qualifies(attempt: Attempt, hasCheck: boolean): boolean {
  if (attempt.stopReason === "error" || attempt.stopReason === "aborted") return false;
  if (hasCheck) return attempt.check?.passed === true && attempt.files > 0;
  const v = attempt.receipt?.verification;
  return attempt.files > 0 && Boolean(v?.ran && v.afterLastChange && v.exitCode === 0);
}

/**
 * Best first: passed the check; changed something; left existing tests alone;
 * finished on its own; agrees with other attempts (same resulting code);
 * smaller change; cheaper.
 */
export function rankAttempts(attempts: readonly Attempt[], hasCheck: boolean): Attempt[] {
  const agreement = new Map<string, number>();
  for (const a of attempts) if (a.tree && a.files > 0) agreement.set(a.tree, (agreement.get(a.tree) ?? 0) + 1);
  const key = (a: Attempt): number[] => [
    qualifies(a, hasCheck) ? 0 : 1,
    hasCheck && a.check && !a.check.passed ? 1 : 0,
    a.files > 0 ? 0 : 1,
    (a.receipt?.testsModified.length ?? 0) > 0 ? 1 : 0,
    a.stopReason === "complete" ? 0 : 1,
    -(a.tree ? agreement.get(a.tree) ?? 0 : 0),
    a.insertions + a.deletions,
    a.costUsd,
    a.spec.n,
  ];
  return [...attempts].sort((x, y) => {
    const kx = key(x);
    const ky = key(y);
    for (let i = 0; i < kx.length; i += 1) if (kx[i] !== ky[i]) return kx[i] - ky[i];
    return 0;
  });
}

/** Attempts whose resulting files are identical to an earlier-ranked one: n → the one it matches. */
export function duplicates(ranked: readonly Attempt[]): Map<number, number> {
  const firstByTree = new Map<string, number>();
  const same = new Map<number, number>();
  for (const a of ranked) {
    if (!a.tree || a.files === 0) continue;
    const earlier = firstByTree.get(a.tree);
    if (earlier === undefined) firstByTree.set(a.tree, a.spec.n);
    else same.set(a.spec.n, earlier);
  }
  return same;
}

/**
 * `--models a,b` and `--tries n` → one spec per attempt. Models may name their
 * provider: `anthropic:claude-sonnet-5-5`, `ollama:qwen3:8b`.
 */
export function planAttempts(input: { tries?: number; models?: string[]; model: string; provider?: LlmProvider }): AttemptSpec[] {
  const models = input.models && input.models.length > 0 ? input.models : [input.model];
  const tries = input.tries ?? (input.models && input.models.length > 0 ? models.length : 3);
  if (!Number.isInteger(tries) || tries < 1) throw new Error("--tries must be a whole number of at least 1");
  if (tries > 12) throw new Error("--tries is limited to 12 attempts at once");
  return Array.from({ length: tries }, (_, i) => {
    const { model, provider } = parseModelSpec(models[i % models.length], input.provider);
    return { n: i + 1, model, provider };
  });
}

export function parseModelSpec(spec: string, defaultProvider?: LlmProvider): { model: string; provider: LlmProvider } {
  const trimmed = spec.trim();
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon);
    if (isLlmProvider(prefix)) {
      const model = trimmed.slice(colon + 1);
      if (!model) throw new Error(`No model after "${prefix}:" in --models`);
      return { model, provider: prefix };
    }
  }
  if (!trimmed) throw new Error("--models has an empty entry");
  return { model: trimmed, provider: resolveProvider(defaultProvider, trimmed) };
}

/** The project's own test command, when it is obvious from its files. */
export function detectCheck(projectRoot: string): string | undefined {
  const has = (file: string): boolean => existsSync(path.join(projectRoot, file));
  const read = (file: string): string => {
    try {
      return readFileSync(path.join(projectRoot, file), "utf8");
    } catch {
      return "";
    }
  };
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
      const test = pkg.scripts?.test;
      if (test && !/no test specified/.test(test)) {
        if (has("pnpm-lock.yaml")) return "pnpm test";
        if (has("yarn.lock")) return "yarn test";
        if (has("bun.lockb") || has("bun.lock")) return "bun run test";
        return "npm test";
      }
    } catch {
      // unreadable package.json: keep looking
    }
  }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pytest.ini") || has("conftest.py") || /\[tool\.pytest/.test(read("pyproject.toml")) || /\[tool:pytest\]/.test(read("setup.cfg")) || has("tests") || has("test")) {
    if (has("pyproject.toml") || has("setup.py") || has("pytest.ini") || has("conftest.py") || has("requirements.txt")) return "python3 -m pytest -q";
  }
  if (/^test:/m.test(read("Makefile"))) return "make test";
  if (has("deno.json") || has("deno.jsonc")) return "deno test";
  if (has("mix.exs")) return "mix test";
  if (has("Gemfile") && has("spec")) return "bundle exec rspec";
  return undefined;
}

function raceName(n: number, task: string): string {
  const short = task.replace(/\s+/g, " ").trim();
  return `race #${n}: ${short.length > 60 ? `${short.slice(0, 59)}…` : short}`;
}

async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
