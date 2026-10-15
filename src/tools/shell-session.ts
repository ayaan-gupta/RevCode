/**
 * Persistent, stateful shell session.
 *
 * A single long-lived `bash` process per agent run so that `cd`, exported
 * environment, virtualenv activation, and backgrounded servers persist across
 * `shell` tool calls. This is the foundation that lets the agent "start a
 * server and keep it running" — something a fresh-`spawn`-per-call shell
 * cannot do.
 *
 * Design notes:
 * - Non-interactive bash (`--norc --noprofile`, no `-i`) so we never inherit
 *   PS1/PS2 prompt echo or job-control "[1] 12345 / [1]+ Done" notifications
 *   that would otherwise pollute the captured stream.
 * - `exec 2>&1` at init merges stderr into stdout for reliable capture (a
 *   single ordered stream to scan for the completion sentinel). Stdout and
 *   stderr are therefore interleaved/merged in results.
 * - Each command is followed by a unique sentinel that prints `$?`, so we can
 *   detect completion and recover the real exit code from a pipe (no TTY).
 * - An async mutex serializes commands: the session is a single shared
 *   stdin/stdout, so two interleaved writes would corrupt sentinel parsing for
 *   both. Every run is strictly serialized regardless of upstream scheduling.
 * - The session leads its own process group (`detached: true`); on dispose we
 *   `kill(-pgid)` to reap the shell AND everything it backgrounded.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 20_000;
const HEAD_CHARS = 12_000;
const TAIL_CHARS = 6_000;
/** Soft cap on the live capture buffer to bound memory on chatty commands. */
const MAX_LIVE_BUFFER = 5_000_000;
/** Window kept at the tail when the live buffer is collapsed (must hold the sentinel). */
const LIVE_TAIL_WINDOW = 65_536;

let outputListener: ((text: string) => void) | undefined;

/**
 * Observe raw command output as it arrives (the interactive UI shows the latest line under
 * "Running …"). Chunks that carry the completion sentinel are filtered out.
 */
export function setShellOutputListener(listener: ((text: string) => void) | undefined): void {
  outputListener = listener;
}

export interface ShellRunOptions {
  timeoutMs?: number;
  /** Launch detached, redirected to a log file, and return immediately. */
  background?: boolean;
}

export interface ShellRunResult {
  /** Merged stdout+stderr with the completion sentinel stripped. */
  stdout: string;
  exitCode: number;
  timedOut?: boolean;
  /** True when the command was interrupted/killed and the session restarted. */
  sessionReset?: boolean;
  truncated?: boolean;
  /** Where the complete output was saved when `truncated` is true. */
  fullOutputFile?: string;
  /** Present when `background: true`. */
  background?: { pid: number | null; logFile: string };
  /** Human-oriented note (e.g. timeout/reset guidance for the model). */
  note?: string;
  /** Set when the shell could not run at all (e.g. its working directory does not exist). */
  error?: string;
}

export interface ShellSessionOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export class ShellSession {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private child?: ChildProcess;
  private pgid?: number;
  private outBuf = "";
  private listeners = new Set<() => void>();
  /** Serial queue (mutex): each run chains onto the previous, success or fail. */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private childExited = false;
  private spawnError: string | undefined;
  private lastExitCode: number | null = null;

  constructor(options: ShellSessionOptions) {
    this.cwd = path.resolve(options.cwd);
    this.env = options.env ?? process.env;
  }

  /** Run a command, serialized behind any in-flight command. */
  run(command: string, options: ShellRunOptions = {}): Promise<ShellRunResult> {
    const exec = () => this.runExclusive(command, options);
    const result = this.queue.then(exec, exec);
    // Keep the queue chained but never reject the chain itself.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Shut down the session WITHOUT force-killing its process group.
   *
   * Foreground commands are awaited (none is in flight here), so the only
   * processes still alive are ones the agent *intentionally* backgrounded
   * (e.g. "start the server and keep it running") — those must survive the
   * agent's exit. We close bash's stdin so it exits on EOF (with `huponexit`
   * off by default it does not SIGHUP its background jobs), and unref the
   * child so Node can exit. In the eval/Harbor case the container teardown
   * reaps anything left; see README "Known limitations".
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const child = this.child;
    this.child = undefined;
    if (!child) {
      return;
    }
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
    try {
      child.stdout?.destroy();
      child.stderr?.destroy();
    } catch {
      // already closed
    }
    try {
      child.unref();
    } catch {
      // already detached
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  // --- internals -----------------------------------------------------------

  private async runExclusive(
    command: string,
    options: ShellRunOptions,
  ): Promise<ShellRunResult> {
    if (this.disposed) {
      throw new Error("Shell session has been disposed");
    }

    const trimmed = command.trim();
    if (!trimmed) {
      throw new Error("shell requires a non-empty command");
    }

    // Best-effort: route an obvious trailing single `&` through the background
    // wrapper so its output cannot leak into the next command's capture window.
    // This is NOT exhaustive shell parsing — `background: true` is the
    // supported, guaranteed path; embedded/quoted `&` may slip through.
    let effectiveCommand = trimmed;
    let background = options.background ?? false;
    if (!background && hasTrailingBackgroundAmp(trimmed)) {
      effectiveCommand = trimmed.replace(/&\s*$/, "").trim();
      background = true;
    }

    this.ensureStarted();

    const timeoutMs = clampTimeout(options.timeoutMs);
    const marker = `__REVCODE_DONE_${randomUUID().replace(/-/g, "")}__`;
    this.outBuf = "";

    if (background) {
      return this.runBackground(effectiveCommand, marker);
    }

    // Foreground. The command is written to a temp file and SOURCED with stdin
    // detached from the session pipe. Sending it inline would let any command
    // that reads stdin (a bare `python3`, `cat`, an apt prompt) swallow the
    // sentinel line below and hang until the timeout. A file also means a
    // syntax error (unbalanced quote, heredoc) fails that one command instead
    // of making bash wait for more input from our pipe. `set +e` afterwards
    // keeps a stray `set -e` from killing the whole session on the next failure.
    const scriptFile = this.writeScript(effectiveCommand);
    const quotedFile = shQuote(scriptFile);
    this.write(`. ${quotedFile} < /dev/null\n`);
    this.write(`__rc=$?; set +e; rm -f ${quotedFile}; printf '\\n%s%d__\\n' "${marker}" "$__rc"\n`);

    const sentinel = await this.waitForSentinel(marker, timeoutMs);
    if (sentinel.found) {
      return this.finishResult(marker, sentinel.exitCode ?? 0);
    }

    if (this.childExited) {
      // The shell itself ended (the command ran `exit`, or it crashed).
      const code = this.lastExitCode;
      const out = this.collapseOutput(stripSentinel(this.outBuf, marker));
      const spawnError = this.spawnError;
      this.spawnError = undefined;
      this.hardRestart();
      if (spawnError) {
        return { stdout: out, exitCode: code ?? 1, error: spawnError };
      }
      return {
        stdout: out,
        exitCode: code ?? 1,
        sessionReset: true,
        note: "The shell process exited (a command ran `exit` or crashed), so a fresh session was started. cwd/env were reset and background processes started from the old session may have been terminated.",
      };
    }

    // Timed out. Interrupt the foreground command via SIGINT to the group
    // (writing \x03 to a non-TTY stdin does nothing). Then give the original
    // sentinel a grace window to appear — if the foreground child was killed,
    // bash returns to read our already-queued `printf` line and the sentinel
    // shows up (typically exit 130). If it never appears (or the shell itself
    // died), hard-restart the session.
    this.killGroup("SIGINT");
    const grace = Math.min(5_000, Math.max(1_000, Math.floor(timeoutMs * 0.5)));
    const afterInt = await this.waitForSentinel(marker, grace);
    if (afterInt.found && !this.childExited) {
      const out = this.finishResult(marker, afterInt.exitCode ?? 130);
      return {
        ...out,
        timedOut: true,
        note: `Command exceeded ${formatSeconds(timeoutMs)} and was interrupted; the shell session was preserved (cwd/env intact). For long-running work, rerun it with background:true and poll its log file.`,
      };
    }

    // Wedged or shell died: hard reset.
    this.hardRestart();
    return {
      stdout: this.collapseOutput(stripSentinel(this.outBuf, marker)),
      exitCode: 124,
      timedOut: true,
      sessionReset: true,
      note:
        `Command exceeded ${formatSeconds(timeoutMs)} and could not be interrupted, so the shell session was reset. ` +
        `cwd/env were reset to their defaults and ANY background processes you started (servers, watchers) have been terminated.`,
    };
  }

  private runBackground(command: string, marker: string): ShellRunResult | Promise<ShellRunResult> {
    const logFile = path.join("/tmp", `revcode-bg-${randomUUID().slice(0, 8)}.log`);
    // `setsid` runs the command in a NEW session/process group, detached from
    // this shell session's group. This is essential: a backgrounded server is
    // meant to KEEP RUNNING after the agent exits, so it must survive the
    // dispose() `kill(-pgid)` that reaps the session. `$!` is the server pid.
    // Falls back to a plain background job if setsid is unavailable.
    const inner = shQuote(command);
    this.write(
      `if command -v setsid >/dev/null 2>&1; then ` +
        `setsid sh -c ${inner} > ${shQuote(logFile)} 2>&1 < /dev/null & ` +
        `else nohup sh -c ${inner} > ${shQuote(logFile)} 2>&1 < /dev/null & fi\n`,
    );
    this.write(`echo "__REVCODE_BG_PID__$!"\n`);
    this.write(`printf '\\n%s%d__\\n' "${marker}" "$?"\n`);

    return this.waitForSentinel(marker, 15_000).then((sentinel) => {
      const raw = stripSentinel(this.outBuf, marker);
      const pidMatch = raw.match(/__REVCODE_BG_PID__(\d+)/);
      const pid = pidMatch ? Number(pidMatch[1]) : null;
      const cleaned = raw.replace(/__REVCODE_BG_PID__\d+\s*/g, "").trim();
      return {
        stdout: cleaned,
        exitCode: sentinel.exitCode ?? 0,
        background: { pid, logFile },
        note: `Started in the background (pid ${pid ?? "unknown"}). Output is being written to ${logFile}; read it with: shell("cat ${logFile}").`,
      } satisfies ShellRunResult;
    });
  }

  private finishResult(marker: string, exitCode: number): ShellRunResult {
    const raw = stripSentinel(this.outBuf, marker);
    const { text, truncated } = truncateHeadTail(raw);
    if (!truncated) {
      return { stdout: text, exitCode };
    }
    const fullOutputFile = spillOutput(raw);
    return {
      stdout: text,
      exitCode,
      truncated: true,
      fullOutputFile,
      note: fullOutputFile
        ? `Output was truncated. The complete output is saved at ${fullOutputFile}; inspect it with grep/sed -n/tail rather than re-running the command.`
        : undefined,
    };
  }

  private collapseOutput(raw: string): string {
    return truncateHeadTail(raw).text;
  }

  private ensureStarted(): void {
    if (this.child && !this.childExited) {
      return;
    }
    this.spawnChild();
  }

  private spawnChild(): void {
    const child = spawn("bash", ["--norc", "--noprofile"], {
      cwd: this.cwd,
      env: { ...this.env, PS1: "", PS2: "", PROMPT_COMMAND: "", TERM: "dumb" },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.pgid = child.pid; // detached → child is its own process-group leader
    this.childExited = false;
    this.outBuf = "";

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (outputListener && !text.includes("__REVCODE_DONE_")) outputListener(text);
      this.outBuf += text;
      if (this.outBuf.length > MAX_LIVE_BUFFER) {
        // Collapse the middle but always keep the tail (holds the sentinel).
        const head = this.outBuf.slice(0, HEAD_CHARS);
        const tail = this.outBuf.slice(-LIVE_TAIL_WINDOW);
        this.outBuf = `${head}\n[… output elided to bound memory …]\n${tail}`;
      }
      this.notify();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      this.childExited = true;
      this.lastExitCode = code;
      this.notify();
    });
    child.on("error", (error) => {
      // Node reports a missing working directory as ENOENT on the *spawn*, which reads like a
      // missing `bash`; say what is actually wrong so the model (and a human) can act on it.
      this.spawnError = (error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(this.cwd)
        ? `The shell could not start because its working directory does not exist: ${this.cwd}. Use absolute paths or create it.`
        : error.message;
      this.childExited = true;
      this.notify();
    });

    // Init: harden the session against prompt/job-control chatter and merge
    // stderr into stdout for ordered capture.
    this.write("set +m\n");
    this.write("set +o history 2>/dev/null\n");
    this.write("PS1=''; PS2=''\n");
    this.write("exec 2>&1\n");
    // Commands run unattended: make well-behaved tools non-interactive so they
    // fail fast or use defaults instead of waiting on a prompt nobody can answer.
    this.write(NON_INTERACTIVE_ENV);
  }

  /** Interrupt the running foreground command (user pressed Ctrl-C). */
  interrupt(): void {
    this.killGroup("SIGINT");
  }

  private writeScript(command: string): string {
    const dir = path.join(os.tmpdir(), "revcode-cmd");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${randomUUID()}.sh`);
    writeFileSync(file, `${command}\n`, { mode: 0o600 });
    // Best-effort cleanup if the session dies before the in-band `rm -f` runs.
    setTimeout(() => {
      try {
        unlinkSync(file);
      } catch {
        // already removed
      }
    }, MAX_TIMEOUT_MS + 60_000).unref();
    return file;
  }

  private hardRestart(): void {
    this.killGroup("SIGKILL");
    this.child = undefined;
    this.childExited = true;
    this.spawnChild();
  }

  private killGroup(signal: NodeJS.Signals): void {
    if (this.pgid) {
      try {
        process.kill(-this.pgid, signal);
      } catch {
        // Group already gone.
      }
    }
    try {
      this.child?.kill(signal);
    } catch {
      // Already exited.
    }
  }

  private write(data: string): void {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(data);
    }
  }

  private notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }

  /**
   * Resolve when the sentinel appears in the buffer (with its exit code) or the
   * deadline elapses. Also resolves (not found) if the child exits.
   */
  private waitForSentinel(
    marker: string,
    timeoutMs: number,
  ): Promise<{ found: boolean; exitCode?: number }> {
    const pattern = new RegExp(`${marker}(\\d+)__`);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { found: boolean; exitCode?: number }) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(value);
      };
      const check = () => {
        const m = this.outBuf.match(pattern);
        if (m) {
          finish({ found: true, exitCode: Number(m[1]) });
        } else if (this.childExited) {
          finish({ found: false });
        }
      };
      const timer = setTimeout(() => finish({ found: false }), timeoutMs);
      this.listeners.add(check);
      check(); // in case the sentinel already arrived
    });
  }
}

// --- helpers ---------------------------------------------------------------

const NON_INTERACTIVE_ENV =
  "export DEBIAN_FRONTEND=noninteractive GIT_TERMINAL_PROMPT=0 PAGER=cat GIT_PAGER=cat MANPAGER=cat EDITOR=true GIT_EDITOR=true VISUAL=true PIP_NO_INPUT=1 PIP_DISABLE_PIP_VERSION_CHECK=1 CI=1 NPM_CONFIG_YES=true NPM_CONFIG_UPDATE_NOTIFIER=false\n";

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

/** Save complete output so the model can grep it instead of re-running the command. */
function spillOutput(raw: string): string | undefined {
  try {
    const dir = path.join(os.tmpdir(), "revcode-out");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${randomUUID().slice(0, 12)}.log`);
    writeFileSync(file, raw, "utf8");
    return file;
  } catch {
    return undefined;
  }
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("shell timeout must be a positive number of milliseconds");
  }
  return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

/** Detect a trailing single `&` (backgrounding) that is not part of `&&`. */
function hasTrailingBackgroundAmp(command: string): boolean {
  return /(^|[^&])&\s*$/.test(command);
}

function stripSentinel(buffer: string, marker: string): string {
  const idx = buffer.indexOf(marker);
  const body = idx === -1 ? buffer : buffer.slice(0, idx);
  // Drop the trailing newline we injected before the sentinel.
  return body.replace(/\n$/, "");
}

export function truncateHeadTail(
  text: string,
  head = HEAD_CHARS,
  tail = TAIL_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text, truncated: false };
  }
  const elided = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n[… ${elided} chars elided …]\n${text.slice(-tail)}`,
    truncated: true,
  };
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
