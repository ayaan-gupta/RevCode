/**
 * Run one Dyno task with a given harness profile and model, then grade it.
 *
 * Each attempt gets a brand-new temp directory and a hermetic runtime (no
 * AGENTS.md / hooks / MCP discovery from the host), so results depend only on
 * the model and the profile under test — never on whatever happens to be
 * installed on the machine running the benchmark.
 */

import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultArgs, type CliArgs } from "../cli.js";
import { createRuntime } from "../agent/setup.js";
import type { StopReason } from "../agent/engine.js";
import type { HarnessProfile } from "../harness/profile.js";
import type { LlmClient } from "../llm/client.js";
import type { DynoTask } from "./types.js";

export interface TaskRunResult {
  taskId: string;
  passed: boolean;
  detail: string;
  stopReason: StopReason | "setup_failed";
  iterations: number;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export interface RunTaskOptions {
  task: DynoTask;
  profile: HarnessProfile;
  llm: LlmClient;
  model: string;
  provider?: CliArgs["provider"];
  /** Hard cap on the attempt in addition to the task's own budget. */
  signal?: AbortSignal;
}

export async function runDynoTask(options: RunTaskOptions): Promise<TaskRunResult> {
  const { task } = options;
  const started = Date.now();
  const dir = mkdtempSync(path.join(os.tmpdir(), `dyno-${task.id}-`));
  const base = { taskId: task.id, iterations: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0 };

  try {
    try {
      await task.setup(dir);
    } catch (error) {
      return { ...base, passed: false, detail: "task setup failed", stopReason: "setup_failed", durationMs: Date.now() - started, error: messageOf(error) };
    }

    const args: CliArgs = {
      ...defaultArgs(),
      cwd: dir,
      model: options.model,
      provider: options.provider,
      headless: true,
      maxIterations: task.maxIterations,
      timeBudgetSec: task.timeoutSec,
      snapshot: true,
      mcp: false,
      hooks: false,
      profile: "default",
    };

    const runtime = await createRuntime({
      args,
      interactive: false,
      llm: options.llm,
      profile: options.profile,
      hermetic: true,
      task: task.instruction,
    });

    const controller = new AbortController();
    const hardStop = setTimeout(() => controller.abort(), (task.timeoutSec + 30) * 1000);
    const onOuterAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onOuterAbort);

    let turn;
    try {
      turn = await runtime.engine.runTurn(task.instruction, controller.signal);
    } finally {
      clearTimeout(hardStop);
      options.signal?.removeEventListener("abort", onOuterAbort);
    }

    // Grade before tearing the runtime down: tasks may check a server the agent left running.
    let grade: { passed: boolean; detail: string };
    try {
      grade = await task.grade(dir);
    } catch (error) {
      grade = { passed: false, detail: `grader crashed: ${messageOf(error)}` };
    }
    await runtime.dispose();

    return {
      ...base,
      passed: grade.passed,
      detail: grade.detail,
      stopReason: turn.stopReason,
      iterations: turn.iterations,
      toolCalls: turn.toolCalls,
      toolErrors: turn.toolErrors,
      durationMs: Date.now() - started,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      error: turn.error,
    };
  } catch (error) {
    return { ...base, passed: false, detail: "runner error", stopReason: "error", durationMs: Date.now() - started, error: messageOf(error) };
  } finally {
    killProcessesInDir(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Background servers outlive the shell by design, so after grading, stop anything
 * still running with its working directory inside the (unique) task directory.
 * Linux-only; elsewhere it is a no-op.
 */
export function killProcessesInDir(dir: string): number {
  if (process.platform !== "linux" || !existsSync("/proc")) {
    return 0;
  }
  const target = path.resolve(dir);
  let killed = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      if (cwd === target || cwd.startsWith(target + path.sep)) {
        process.kill(Number(entry), "SIGKILL");
        killed += 1;
      }
    } catch {
      // process gone or not ours
    }
  }
  return killed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
