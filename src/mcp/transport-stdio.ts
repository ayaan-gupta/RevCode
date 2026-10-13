/**
 * MCP stdio transport: spawn the server as a child process and exchange
 * newline-delimited JSON-RPC 2.0 messages over its stdin/stdout.
 *
 * Design notes:
 * - Framing is one JSON document per line, in both directions (the MCP stdio
 *   spec forbids embedded newlines). Stdout lines that are not JSON-RPC are
 *   not fatal: some servers print banners or logs to stdout by mistake. They
 *   are recorded in the diagnostics buffer and skipped.
 * - stderr is ALWAYS drained, even though nothing needs it live: an
 *   undrained pipe fills (~64KB) and blocks the server mid-write, which looks
 *   exactly like a hung server. The last ~8KB is kept in a ring buffer so the
 *   reason a server died ("Error: GITHUB_TOKEN is required") reaches the
 *   user instead of an opaque "connection closed".
 * - Early exit rejects everything pending: the transport reports the exit via
 *   `onclose(error)` with the exit status AND the stderr tail, and the client
 *   fails each in-flight request with that error.
 * - Shutdown: close stdin (the polite EOF signal), SIGTERM straight away, and
 *   SIGKILL after a 2s grace period for servers that ignore it. The signals
 *   are sent synchronously inside `close()`, so even a caller that does not
 *   await it (process is about to exit) still reaps the child. A single
 *   process-level `exit` hook covers callers that never call `close()` at all.
 * - The child inherits RevCode's environment plus the configured `env`
 *   (which wins). That matches Claude Code and is what `npx`/`uvx`-launched
 *   servers need (PATH, HOME, npm config, proxies), but it does mean a server
 *   can read RevCode's own environment variables, so only configure servers
 *   you trust. On Windows, commands such as `npx` are `.cmd` shims that
 *   cannot be spawned directly; configure `"command": "cmd", "args": ["/c", "npx", ...]`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  ErrorCode,
  McpError,
  parseJsonRpcMessage,
  type JsonRpcMessage,
  type McpTransport,
} from "./types.js";

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  /** Extra environment variables, layered over `process.env`. */
  env?: Record<string, string>;
  cwd?: string;
  /** Server name for error messages. */
  label?: string;
  /** Size of the stderr ring buffer. Default 8192 characters. */
  stderrBufferChars?: number;
  /** Delay between SIGTERM and SIGKILL. Default 2000ms. */
  killGraceMs?: number;
}

const DEFAULT_STDERR_CHARS = 8 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
/** A single JSON-RPC line larger than this is treated as a broken server. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;
/** How much of the stderr tail is quoted inside error messages. */
const ERROR_TAIL_CHARS = 2_000;
/** After `exit`, how long to wait for stdio to drain before declaring the transport closed. */
const EXIT_DRAIN_MS = 250;

/** Children still alive; reaped by the one-time process `exit` hook below. */
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;

function trackChild(child: ChildProcessWithoutNullStreams): void {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const alive of liveChildren) {
        try {
          alive.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    });
  }
}

export class StdioTransport implements McpTransport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;
  ondiagnostic?: (text: string) => void;

  private readonly options: StdioTransportOptions;
  private readonly label: string;
  private readonly stderrLimit: number;
  private child: ChildProcessWithoutNullStreams | undefined;
  private stderrTail = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private scanFrom = 0;
  private exited = false;
  private spawnFailed = false;
  private exitDescription = "";
  private closing = false;
  private finished = false;
  private drainTimer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private closePromise: Promise<void> | undefined;
  private resolveFinished: (() => void) | undefined;
  private readonly finishedPromise = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(options: StdioTransportOptions) {
    this.options = options;
    this.label = options.label ?? options.command;
    this.stderrLimit = options.stderrBufferChars ?? DEFAULT_STDERR_CHARS;
  }

  /** Process id of the server, once started. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The last ~8KB the server wrote to stderr (plus any non-JSON stdout lines). */
  diagnostics(): string {
    return this.stderrTail;
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("StdioTransport can only be started once.");
    }
    const { command, args = [], env, cwd } = this.options;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (!this.exited && child.pid === undefined) {
          this.spawnFailed = true; // no process, so no exit/close events will ever arrive
          reject(new McpError(ErrorCode.ConnectionClosed, this.describeSpawnError(error)));
        } else {
          this.diagnose(`process error: ${error.message}`);
        }
      });
    });

    trackChild(child);
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendTail(this.stderrDecoder.write(chunk)));
    // An EPIPE on stdin (server already gone) must not become an uncaught 'error' event.
    child.stdin.on("error", (error) => this.diagnose(`stdin error: ${error.message}`));
    child.once("exit", (code, signal) => {
      this.exited = true;
      this.exitDescription = describeExit(code, signal);
      // `close` fires once stdio is drained; if a grandchild keeps the pipes
      // open it may never come, so do not wait forever.
      this.drainTimer = setTimeout(() => this.finish(), EXIT_DRAIN_MS);
      this.drainTimer.unref();
    });
    child.once("close", () => this.finish());
  }

  send(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (this.exited && !this.finished && !this.closing) {
      // The process is gone but its stderr may still be in the pipe. Wait for
      // the drain so the error carries the complete tail, not a prefix of it.
      return this.finishedPromise.then(() => Promise.reject(this.unavailableError()));
    }
    if (!child || this.closing || this.exited || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(this.unavailableError());
    }
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(new McpError(ErrorCode.ConnectionClosed, `Could not write to MCP server "${this.label}": ${error.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  // --- internals -----------------------------------------------------------

  private doClose(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child || this.exited || this.spawnFailed) {
      this.finish();
      return this.finishedPromise;
    }
    // All signalling happens synchronously, before the first await.
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    this.killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    this.killTimer.unref();

    // Bounded wait: never let a process stuck in the kernel hang shutdown.
    return new Promise<void>((resolve) => {
      const failsafe = setTimeout(resolve, (this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS) + 1_000);
      failsafe.unref();
      void this.finishedPromise.then(() => {
        clearTimeout(failsafe);
        resolve();
      });
    });
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.stdoutDecoder.write(chunk);
    let start = 0;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n", Math.max(start, this.scanFrom));
      if (newline === -1) {
        break;
      }
      this.handleLine(this.stdoutBuffer.slice(start, newline));
      start = newline + 1;
    }
    this.stdoutBuffer = this.stdoutBuffer.slice(start);
    // What is left has no newline; the next scan only needs to cover new data.
    this.scanFrom = this.stdoutBuffer.length;
    if (this.stdoutBuffer.length > MAX_LINE_CHARS) {
      this.diagnose(`stdout line exceeded ${MAX_LINE_CHARS} characters; terminating server`);
      this.stdoutBuffer = "";
      this.scanFrom = 0;
      void this.close();
    }
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") {
      return;
    }
    const first = line.trimStart()[0];
    if (first !== "{" && first !== "[") {
      this.diagnose(`non-JSON on stdout: ${truncateForLog(line)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.diagnose(`invalid JSON on stdout: ${truncateForLog(line)}`);
      return;
    }
    // Batches were part of one protocol revision; accept them defensively.
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const message = parseJsonRpcMessage(item);
      if (message) {
        try {
          this.onmessage?.(message);
        } catch (error) {
          this.diagnose(`message handler threw: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        this.diagnose(`ignoring non-JSON-RPC message: ${truncateForLog(line)}`);
      }
    }
  }

  /** Record a diagnostic line in the ring buffer and notify the listener. */
  private diagnose(text: string): void {
    this.appendTail(`[revcode] ${text}\n`);
    this.ondiagnostic?.(text);
  }

  private appendTail(text: string): void {
    if (text === "") {
      return;
    }
    const combined = this.stderrTail + text;
    this.stderrTail = combined.length > this.stderrLimit ? combined.slice(combined.length - this.stderrLimit) : combined;
  }

  /** Called once stdio has drained after exit (or immediately if never started). */
  private finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.killTimer) clearTimeout(this.killTimer);

    // A final line without a trailing newline still counts.
    const rest = this.stdoutBuffer + this.stdoutDecoder.end();
    this.stdoutBuffer = "";
    if (rest.trim() !== "" && !this.closing) {
      this.handleLine(rest);
    }
    this.appendTail(this.stderrDecoder.end());

    this.onclose?.(this.closing ? undefined : this.unavailableError());
    this.resolveFinished?.();
  }

  /** Error for "the server is gone", including why, when we know. */
  private unavailableError(): McpError {
    if (!this.exited && !this.finished) {
      return new McpError(ErrorCode.ConnectionClosed, `MCP server "${this.label}" is not running.`);
    }
    const tail = this.stderrTail.trim();
    const quoted = tail === "" ? "(no stderr output)" : tail.slice(-ERROR_TAIL_CHARS);
    return new McpError(
      ErrorCode.ConnectionClosed,
      `MCP server "${this.label}" exited unexpectedly${this.exitDescription}.\nstderr:\n${quoted}`,
    );
  }

  private describeSpawnError(error: NodeJS.ErrnoException): string {
    const { command, cwd } = this.options;
    if (error.code === "ENOENT") {
      return `Could not start MCP server "${this.label}": command "${command}" was not found${
        cwd ? ` (or working directory "${cwd}" does not exist)` : ""
      }. Check that it is installed and on PATH.`;
    }
    if (error.code === "EACCES") {
      return `Could not start MCP server "${this.label}": permission denied running "${command}".`;
    }
    return `Could not start MCP server "${this.label}": ${error.message}`;
  }
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) {
    return ` (killed by ${signal})`;
  }
  return code === null ? "" : ` with code ${code}`;
}

function truncateForLog(line: string): string {
  return line.length > 200 ? `${line.slice(0, 200)}... (${line.length} chars)` : line;
}
