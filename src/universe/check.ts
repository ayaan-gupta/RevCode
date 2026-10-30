/**
 * Run the user's check command (tests, build, lint…) inside a universe's copy.
 *
 * Used by `revcode run --land-if`, `revcode race` and `revcode universes compare`.
 * The command runs in its own process group so a timeout also stops whatever it
 * started (test runners love child processes).
 */

import { spawn } from "node:child_process";
import { forChildShell } from "../net/env-proxy.js";

export interface CheckResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  /** The last lines of output, for showing why it failed. */
  tail: string;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 20 * 60 * 1000;

export function runCheck(cwd: string, command: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CheckResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: { ...forChildShell(process.env), CI: process.env.CI ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      out = (out + chunk.toString("utf8")).slice(-8000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const killGroup = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const onAbort = (): void => killGroup();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null, extra = ""): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const text = `${out}${extra}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
      resolve({
        command,
        exitCode,
        passed: exitCode === 0 && !timedOut,
        timedOut,
        durationMs: Date.now() - started,
        tail: [...text.split("\n").slice(-8), ...(timedOut ? [`(stopped after ${Math.round(timeoutMs / 1000)}s)`] : [])].join("\n").trim(),
      });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (error) => finish(null, `\n${error.message}`));
  });
}

/** "npm test passed (12s)" / "npm test failed (exit 1, 3s)". */
export function describeCheck(check: CheckResult): string {
  const secs = check.durationMs >= 10_000 ? `${Math.round(check.durationMs / 1000)}s` : `${(check.durationMs / 1000).toFixed(1)}s`;
  if (check.passed) return `${check.command} passed (${secs})`;
  if (check.timedOut) return `${check.command} timed out (${secs})`;
  return `${check.command} failed (exit ${check.exitCode ?? "?"}, ${secs})`;
}
