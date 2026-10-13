/**
 * Run one hook command: `bash -c <command>` with the event JSON on stdin.
 *
 * The child leads its own process group so a timeout can SIGKILL the whole
 * tree (a hook that shells out to `sleep` or a test runner must not outlive
 * its budget). The promise always resolves and never rejects; spawn failures
 * are reported in the result.
 */

import { spawn, type ChildProcess } from "node:child_process";

/** Cap per stream so a runaway hook cannot balloon memory. */
const MAX_CAPTURE_CHARS = 256 * 1024;
/**
 * After the shell exits we wait this long for the pipes to close. A hook that
 * backgrounds a daemon (`server &`) leaves it holding stdout open forever;
 * without this the hook would appear to hang until its timeout.
 */
const POST_EXIT_GRACE_MS = 250;

export interface HookProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin, then closed. */
  input: string;
  timeoutMs: number;
}

export interface HookProcessResult {
  /** Null when killed by a signal or when the process never started. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export function runHookProcess(command: string, options: HookProcessOptions): Promise<HookProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timers: { timeout?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {};
    let child: ChildProcess | undefined;

    const finish = (outcome: Partial<HookProcessResult>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timers.timeout);
      clearTimeout(timers.grace);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({ exitCode: null, signal: null, stdout, stderr, timedOut: false, ...outcome });
    };

    try {
      child = spawn("bash", ["-c", command], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }

    child.on("error", (error) => finish({ spawnError: error.message }));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk.slice(0, Math.max(0, MAX_CAPTURE_CHARS - stdout.length));
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk.slice(0, Math.max(0, MAX_CAPTURE_CHARS - stderr.length));
    });

    child.on("exit", (exitCode, signal) => {
      timers.grace = setTimeout(() => finish({ exitCode, signal }), POST_EXIT_GRACE_MS);
    });
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));

    timers.timeout = setTimeout(() => {
      killProcessGroup(child);
      finish({ timedOut: true });
    }, options.timeoutMs);

    // The hook may exit without reading stdin; that surfaces as EPIPE, which is not an error here.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });
}

function killProcessGroup(child: ChildProcess | undefined): void {
  if (!child) {
    return;
  }
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // Group already gone, or not a group leader: fall through to the direct kill.
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Nothing left to kill.
  }
}
