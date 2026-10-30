/**
 * `revcode race "<task>" [--tries 3] [--models a,b] [--check "<cmd>"] [--yes]`
 *
 * Runs several attempts at once in private copies, checks each with the
 * project's tests, shows a live scoreboard, and offers to apply the best one.
 */

import * as readline from "node:readline/promises";
import { workingDirectoryProblem } from "../agent/cwd.js";
import type { CliArgs } from "../cli.js";
import { priceFor } from "../llm/pricing.js";
import { SpendMeter } from "../llm/spend.js";
import { boardHeader, finalRows, liveRows, type BoardContext } from "../race/board.js";
import { detectCheck, duplicates, planAttempts, runRace, type Attempt, type AttemptSpec, type RaceResult } from "../race/race.js";
import { detectCaps, Style } from "../tui/style.js";
import { truncate, wrapAnsi } from "../tui/width.js";
import { formatChangeSummary, landFlow, landOutcome } from "../universe/ui.js";
import { missingCredentials } from "./setup.js";

export interface RaceCommandOptions {
  tries?: number;
  models?: string[];
  check?: string;
  parallel?: number;
  /** Apply the winner without asking. */
  yes: boolean;
}

export async function runRaceCommand(args: CliArgs, options: RaceCommandOptions): Promise<number> {
  const task = args.prompt?.trim();
  if (!task) {
    console.error('Usage: revcode race "<task>" [--tries 3] [--models a,b] [--check "npm test"] [--max-cost 2] [--yes]');
    return 2;
  }
  const cwdProblem = workingDirectoryProblem(args.cwd);
  if (cwdProblem) {
    console.error(`[revcode] ${cwdProblem}`);
    return 2;
  }

  let specs: AttemptSpec[];
  try {
    specs = planAttempts({ tries: options.tries, models: options.models, model: args.model, provider: args.provider });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  for (const spec of unique(specs)) {
    const missing = missingCredentials({ provider: spec.provider, model: spec.model, baseUrl: args.baseUrl });
    if (missing) {
      console.error(`${missing.message} (needed for ${spec.model}). Run "revcode setup" or set the key in your environment.`);
      return 2;
    }
    if (args.maxCost !== undefined && spec.provider !== "openrouter" && !priceFor(spec.model, spec.provider, args.pricing)) {
      console.error(`--max-cost needs to know what ${spec.model} costs. Add it under "pricing" in .revcode/config.json ($ per million tokens).`);
      return 2;
    }
  }

  const json = args.outputFormat === "json" || args.outputFormat === "stream-json";
  const check = options.check ?? detectCheck(args.cwd);
  const tty = Boolean(process.stdout.isTTY) && !json && process.env.TERM !== "dumb";
  const style = new Style(detectCaps(process.env, tty, args.theme === "auto" ? undefined : args.theme));
  const spend = new SpendMeter(args.maxCost);
  // Show dollars when at least one model costs something (local models are free).
  const priced = specs.some((s) => {
    const price = priceFor(s.model, s.provider, args.pricing);
    return s.provider === "openrouter" || (price !== undefined && price.input + price.output > 0);
  });
  const ctx = (): BoardContext => ({ style, width: Math.max(60, process.stdout.columns ?? 100), check, capUsd: spend.capUsd, spentUsd: spend.spentUsd, priced });
  const log = (line: string): void => {
    if (!json) console.log(line);
  };

  log(boardHeader(task, specs.length, ctx()).join("\n"));
  if (!options.check && check) log(style.dim(`  Checking each attempt with "${check}" (found in this project; change it with --check).`));
  if (!check) log(style.paint("warn", `  No check command found, so attempts are ranked by their own test runs. Pass --check "<command>" for a fair comparison.`));
  log("");

  const live = tty ? new LiveBoard((frame) => liveRows(attemptsView, { ...ctx(), frame })) : undefined;
  let attemptsView: readonly Attempt[] = [];
  const announced = new Map<number, string>();
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts > 1) {
      live?.stop();
      process.exit(130);
    }
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  let result: RaceResult;
  try {
    live?.start();
    result = await runRace({
      task,
      args,
      attempts: specs,
      check,
      parallel: options.parallel,
      spend,
      signal: controller.signal,
      warn: (message) => (live ? live.log(style.dim(`  ${message}`)) : process.stderr.write(`[revcode] ${message}\n`)),
      onUpdate: (attempts) => {
        attemptsView = attempts;
        if (live || json) return;
        for (const a of attempts) {
          const key = `${a.status}`;
          if (announced.get(a.spec.n) === key) continue;
          announced.set(a.spec.n, key);
          if (a.status === "working") log(`#${a.spec.n} ${a.spec.model}: started`);
          if (a.status === "checking") log(`#${a.spec.n} ${a.spec.model}: checking`);
          if (a.status === "done") log(`#${a.spec.n} ${a.spec.model}: ${a.check ? (a.check.passed ? "check passed" : "check failed") : a.stopReason ?? "done"} (${a.files} file${a.files === 1 ? "" : "s"} changed)`);
        }
      },
    });
  } catch (error) {
    live?.stop();
    process.off("SIGINT", onSigint);
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    live?.stop();
  }
  process.off("SIGINT", onSigint);

  if (json) {
    console.log(JSON.stringify(jsonSummary(result, check)));
    return result.winner ? (options.yes ? await applyWinner(result, result.winner, style, true) : 0) : 1;
  }

  log(finalRows(result, ctx()).join("\n"));
  log("");

  if (controller.signal.aborted) {
    log("Stopped. The attempts are kept as they were:");
    log(keepHints(result.attempts));
    return 130;
  }

  const winner = result.winner;
  if (!winner) {
    const passedWithoutChanges = result.attempts.some((a) => a.check?.passed && a.files === 0);
    log(
      style.paint(
        "warn",
        passedWithoutChanges && !result.attempts.some((a) => a.check?.passed && a.files > 0)
          ? `"${check}" passes, but no attempt changed anything, so there is nothing to apply.`
          : check
            ? `No attempt passed "${check}". Nothing was applied.`
            : "No attempt finished with changes it had tested. Nothing was applied.",
      ),
    );
    const withChanges = result.ranked.filter((a) => a.files > 0);
    if (withChanges.length > 0) log(`The attempts are kept so you can look at them:\n${keepHints(withChanges)}`);
    return 1;
  }

  await showWinner(winner, result, style);
  if (options.yes) return applyWinner(result, winner, style, false);
  if (!process.stdin.isTTY) {
    log(`To apply it: revcode universes land ${winner.universe!.id}   (or re-run with --yes)`);
    return 0;
  }
  let chosen: Attempt = winner;
  for (;;) {
    const answer: string = (await ask(`Apply #${chosen.spec.n} to your project? [Y/n, d = show diff${result.ranked.filter((a) => a.files > 0).length > 1 ? ", or an attempt number" : ""}] `)).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return applyWinner(result, chosen, style, false);
    if (answer === "n" || answer === "no") {
      log(`Nothing was applied. The attempts are kept:\n${keepHints(result.ranked.filter((a) => a.files > 0))}`);
      return 0;
    }
    if (answer === "d" || answer === "diff") {
      log(await chosen.universe!.diff());
      continue;
    }
    const picked: Attempt | undefined = result.attempts.find((a) => String(a.spec.n) === answer.replace(/^#/, ""));
    if (picked && picked.files > 0) {
      chosen = picked;
      await showWinner(picked, result, style);
      continue;
    }
    log(picked ? `#${picked.spec.n} made no changes.` : "Type y, n, d, or an attempt number.");
  }
}

async function showWinner(attempt: Attempt, result: RaceResult, style: Style): Promise<void> {
  const universe = attempt.universe!;
  const same = [...duplicates(result.ranked)].filter(([, to]) => to === attempt.spec.n).map(([n]) => `#${n}`);
  console.log(`${style.bold(`#${attempt.spec.n}`)} ${style.dim(`(${attempt.spec.model})`)}${same.length ? style.dim(` — ${same.join(", ")} wrote the same code`) : ""}`);
  console.log(formatChangeSummary(await universe.changesBetween(universe.meta.baseSha, await universe.snapshotHead("race result"))).join("\n"));
  const summary = closingSummary(attempt.finalMessage ?? "", Math.max(40, (process.stdout.columns ?? 100) - 4));
  if (summary.length > 0) console.log(style.dim(summary.map((line) => `  ${line}`).join("\n")));
  console.log("");
}

async function applyWinner(result: RaceResult, attempt: Attempt, style: Style, quiet: boolean): Promise<number> {
  const universe = attempt.universe!;
  const flow = await landFlow(universe, {
    confirm: async (_plan, lines) => {
      if (!quiet) console.log(lines.join("\n"));
      return true;
    },
  });
  const conflicts = flow.result?.conflicts.length ?? 0;
  if (!quiet) console.log(landOutcome(flow).join("\n"));
  if (!flow.landed || conflicts > 0) {
    if (!quiet) console.log(style.paint("warn", `Not everything could be applied. #${attempt.spec.n} is kept: revcode universes land ${universe.id}`));
    return 1;
  }
  // Applied: the copies have done their job.
  for (const a of result.attempts) {
    try {
      a.universe?.discard();
    } catch {
      // best effort
    }
  }
  if (!quiet) console.log(style.paint("ok", `${style.glyphs.check} Applied #${attempt.spec.n}.`));
  return 0;
}

/** The agent's closing words: its last paragraph, without markdown emphasis, at most three lines. */
export function closingSummary(message: string, width: number): string[] {
  const paragraphs = message.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = (paragraphs.at(-1) ?? "").replace(/\*\*|__|`/g, "").replace(/^summary:\s*/i, "").replace(/\s+/g, " ").trim();
  if (!last) return [];
  const lines = wrapAnsi(last, width);
  return lines.length > 3 ? [...lines.slice(0, 2), truncate(`${lines[2]} ${lines.slice(3).join(" ")}`, width)] : lines;
}

function keepHints(attempts: readonly Attempt[]): string {
  return attempts
    .filter((a) => a.universe)
    .map((a) => `  #${a.spec.n}  revcode universes diff ${a.universe!.id}   ·   revcode universes land ${a.universe!.id}`)
    .join("\n");
}

function jsonSummary(result: RaceResult, check: string | undefined): Record<string, unknown> {
  return {
    check: check ?? null,
    winner: result.winner?.spec.n ?? null,
    spentUsd: Number(result.spentUsd.toFixed(6)),
    attempts: result.ranked.map((a) => ({
      n: a.spec.n,
      model: a.spec.model,
      provider: a.spec.provider,
      universe: a.universe?.id,
      stopReason: a.stopReason,
      passed: a.check?.passed ?? null,
      exitCode: a.check?.exitCode ?? null,
      files: a.files,
      insertions: a.insertions,
      deletions: a.deletions,
      steps: a.steps,
      costUsd: Number(a.costUsd.toFixed(6)),
      durationMs: a.startedAt && a.endedAt ? a.endedAt - a.startedAt : null,
      testsModified: a.receipt?.testsModified ?? [],
      ...(a.error ? { error: a.error } : {}),
    })),
  };
}

function unique(specs: AttemptSpec[]): AttemptSpec[] {
  const seen = new Set<string>();
  return specs.filter((s) => {
    const key = `${s.provider}:${s.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch {
    return "n";
  } finally {
    rl.close();
  }
}

/** Redraws a block of lines in place; other output scrolls above it. */
class LiveBoard {
  private drawn = 0;
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly render: (frame: number) => string[]) {}

  start(): void {
    process.stdout.write("\x1b[?25l");
    this.draw();
    this.timer = setInterval(() => {
      this.frame += 1;
      this.draw();
    }, 120);
  }

  log(line: string): void {
    this.clear();
    process.stdout.write(`${line}\n`);
    this.draw();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.clear();
    process.stdout.write("\x1b[?25h");
  }

  private clear(): void {
    if (this.drawn > 0) process.stdout.write(`\x1b[${this.drawn}A\r\x1b[J`);
    this.drawn = 0;
  }

  private draw(): void {
    // Lines must never wrap, or clearing them next time would leave stray rows behind.
    const columns = Math.max(20, (process.stdout.columns ?? 100) - 1);
    const lines = this.render(this.frame).map((line) => truncate(line, columns));
    this.clear();
    process.stdout.write(`${lines.join("\n")}\n`);
    this.drawn = lines.length;
  }
}
