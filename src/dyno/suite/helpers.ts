/**
 * Shared plumbing for the built-in Dyno suite.
 *
 * Everything here exists so task graders stay deterministic and side-effect
 * free: commands run with hard timeouts in their own process group, Python never
 * writes bytecode into the directory under grade, generated fixtures come from a
 * seeded PRNG, and anything that has to execute the agent's code does so in a
 * throw-away copy of the task directory.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { GradeResult } from "../types.js";

// ---------------------------------------------------------------------------
// Grade results
// ---------------------------------------------------------------------------

export function pass(detail = "ok"): GradeResult {
  return { passed: true, detail };
}

export function fail(detail: string): GradeResult {
  return { passed: false, detail };
}

/** JSON with object keys sorted, so two structurally equal values compare equal as strings. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return inner;
  });
}

/**
 * Keep failure details short enough for a report line. Scratch-copy paths are
 * replaced so the same failure always reads the same (grading must be repeatable).
 */
export function clip(text: string, max = 400): string {
  const flat = text.trim().replace(/[^\s"'(]*dyno-grade-\w{6}/g, "<scratch>");
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------

export interface RunOptions {
  cwd: string;
  /** Hard wall-clock limit; the whole process group is SIGKILLed when it elapses. */
  timeoutMs?: number;
  input?: string;
  /** Merged over `process.env`; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_CAPTURE = 2_000_000;

/** SIGKILL a process group, ignoring the "already gone" races. */
export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already exited
    }
  }
}

/**
 * Run a command to completion. The child leads its own process group so a
 * timeout (or a script that forks and exits) can never leave strays behind.
 */
export function run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: String(error), timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk;
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid);
    }, options.timeoutMs ?? 30_000);

    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.on("exit", () => {
      // A script that backgrounded something would otherwise hold the pipes open.
      killProcessGroup(child.pid);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr: spawnError ? `${stderr}${spawnError}` : stderr, timedOut });
    });
  });
}

/** Environment that keeps Python from touching the directory it runs in. */
const PYTHON_ENV = {
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
  PYTHONHASHSEED: "0",
  PYTHONPATH: undefined,
} as const;

export function python(args: readonly string[], options: RunOptions): Promise<RunResult> {
  return run("python3", ["-B", ...args], { ...options, env: { ...PYTHON_ENV, ...options.env } });
}

/** Run an inline Python program with `cwd` importable (as `python3 -c` does). */
export function pythonCode(code: string, options: RunOptions): Promise<RunResult> {
  return python(["-c", code], options);
}

export function bash(args: readonly string[], options: RunOptions): Promise<RunResult> {
  return run("bash", args, { ...options, env: { LC_ALL: "C", ...options.env } });
}

/** Git with host configuration (signing, hooks, identity, default branch) shut out. */
export function git(args: readonly string[], options: RunOptions): Promise<RunResult> {
  return run("git", ["--no-optional-locks", ...args], {
    ...options,
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      ...options.env,
    },
  });
}

// ---------------------------------------------------------------------------
// unittest output
// ---------------------------------------------------------------------------

export interface UnittestSummary {
  ran: number;
  ok: boolean;
}

/** Parse the trailer `python3 -m unittest` prints on stderr ("Ran N tests … OK"). */
export function parseUnittest(output: string): UnittestSummary | undefined {
  const ran = /^Ran (\d+) tests? in /m.exec(output);
  if (!ran) return undefined;
  return { ran: Number(ran[1]), ok: /^OK\b/m.test(output) };
}

/** First lines naming failing tests ("FAIL: test_x (…)" / "ERROR: …"), for report details. */
export function failingTests(output: string): string[] {
  return [...output.matchAll(/^(?:FAIL|ERROR): (\S+)/gm)].map((m) => m[1] ?? "");
}

// ---------------------------------------------------------------------------
// Files and hashing
// ---------------------------------------------------------------------------

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function writeFiles(dir: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

export function readText(dir: string, relative: string): string | undefined {
  try {
    return fs.readFileSync(path.join(dir, relative), "utf8");
  } catch {
    return undefined;
  }
}

const SKIPPED_DIRS = new Set([".git", "__pycache__", "node_modules"]);

/** Every file under `dir` as a sorted list of POSIX-style relative paths. */
export function listFiles(dir: string, skip: ReadonlySet<string> = SKIPPED_DIRS): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        found.push(path.relative(dir, path.join(current, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  return found.sort();
}

/** Content digest of the whole tree (paths + bytes + exec bit), ignoring VCS and bytecode. */
export function treeDigest(dir: string): string {
  const hash = createHash("sha256");
  for (const relative of listFiles(dir)) {
    const absolute = path.join(dir, relative);
    const executable = (fs.statSync(absolute).mode & 0o111) !== 0;
    hash.update(`${relative}\0${executable ? "x" : "-"}\0`);
    hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Copy `dir` somewhere disposable, run `fn` there, and delete the copy. Graders
 * that must execute the agent's code use this so grading never mutates the
 * attempt (and a second grade sees exactly what the first did).
 */
export async function withScratchCopy<T>(dir: string, fn: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dyno-grade-"));
  try {
    await fs.promises.cp(dir, scratch, {
      recursive: true,
      filter: (source) => !SKIPPED_DIRS.has(path.basename(source)),
    });
    return await fn(scratch);
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Deterministic generation
// ---------------------------------------------------------------------------

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — tiny, fast, and identical on every machine. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
  };
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");

// ---------------------------------------------------------------------------
// Network: servers that tasks leave running
// ---------------------------------------------------------------------------

/** Inodes of TCP sockets in LISTEN state on `port` (IPv4 and IPv6). */
function listeningInodes(port: number): Set<string> {
  const inodes = new Set<string>();
  const wanted = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = fs.readFileSync(table, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      const local = columns[1];
      const state = columns[3];
      const inode = columns[9];
      if (local && state === "0A" && inode && local.endsWith(`:${wanted}`)) {
        inodes.add(inode);
      }
    }
  }
  return inodes;
}

/** PIDs of processes listening on `port`. Linux-only (reads /proc); empty elsewhere. */
export function listeningPids(port: number): number[] {
  const inodes = listeningInodes(port);
  if (inodes.size === 0) return [];
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const fdDir = `/proc/${entry}/fd`;
    let fds: string[];
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = fs.readlinkSync(`${fdDir}/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match?.[1] && inodes.has(match[1])) {
          pids.push(Number(entry));
          break;
        }
      } catch {
        // fd closed while scanning
      }
    }
  }
  return pids;
}

/** SIGKILL whatever listens on `port` (and its process group). Returns the PIDs hit. */
export async function killListeners(port: number): Promise<number[]> {
  const killed: number[] = [];
  for (let round = 0; round < 3; round++) {
    const pids = listeningPids(port).filter((pid) => pid !== process.pid);
    if (pids.length === 0) break;
    for (const pid of pids) {
      killProcessGroup(pid);
      killed.push(pid);
    }
    await sleep(100);
  }
  return killed;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface HttpResponse {
  status: number;
  body: string;
  contentType: string;
}

/** One HTTP GET with its own timeout; rejects on connection errors. */
export function httpGet(url: string, timeoutMs = 2_000): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          contentType: String(response.headers["content-type"] ?? ""),
        }),
      );
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    request.on("error", reject);
  });
}

/** GET with a retry loop, for servers that may still be binding their socket. */
export async function httpGetWithRetry(url: string, totalMs = 6_000): Promise<HttpResponse> {
  const deadline = Date.now() + totalMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await httpGet(url);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await sleep(150);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Cross-process mutex for a fixed TCP port, built on an atomic `mkdir`.
 *
 * Several processes may run the suite's validity tests at once (parallel CI
 * shards, two developers on one box, a second `vitest run src/dyno`), and a
 * grader that kills "whatever listens on the port" must never fire while another
 * process is mid-attempt on that port. Locks left by a crashed process are
 * detected by pid and by age.
 */
export async function withPortLock<T>(port: number, fn: () => Promise<T>): Promise<T> {
  const lockDir = path.join(os.tmpdir(), `dyno-port-${port}.lock`);
  const pidFile = path.join(lockDir, "pid");
  const waitUntil = Date.now() + 180_000;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(pidFile, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockIsStale(lockDir, pidFile)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > waitUntil) throw new Error(`timed out waiting for the lock on port ${port}`);
      await sleep(200);
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function lockIsStale(lockDir: string, pidFile: string): boolean {
  try {
    const owner = Number(fs.readFileSync(pidFile, "utf8"));
    if (Number.isInteger(owner) && owner > 0) {
      process.kill(owner, 0);
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  // No readable owner yet (the creator may be between mkdir and writing its pid): only give up when old.
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > 10 * 60_000;
  } catch {
    return true;
  }
}

/** Start a long-lived process fully detached from the test runner (stdio ignored). */
export function startDetached(command: string, args: readonly string[], cwd: string): void {
  const child = spawn(command, [...args], { cwd, detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
