/**
 * Tool: execute a shell command.
 */

import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

export interface ShellToolInput {
  command: string;
  timeout?: number;
  cwd?: string;
}

export interface ShellToolOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellToolOptions {
  cwd?: string;
}

export async function execShell(
  input: ShellToolInput,
  options: ShellToolOptions = {},
): Promise<ShellToolOutput> {
  const normalizedInput = normalizeInput(input);
  const baseCwd = path.resolve(options.cwd ?? process.cwd());
  const commandCwd = resolveCwdInsideBase(normalizedInput.cwd ?? ".", baseCwd);
  const timeout = normalizeTimeout(normalizedInput.timeout);

  return new Promise<ShellToolOutput>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(normalizedInput.command, {
      cwd: commandCwd,
      shell: true,
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendTruncated(stdout, chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendTruncated(stderr, chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        stderr = appendTruncated(stderr, `\nCommand timed out after ${timeout}ms`);
      }

      if (signal && !timedOut) {
        stderr = appendTruncated(stderr, `\nCommand terminated by signal ${signal}`);
      }

      resolve({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : (code ?? 1),
      });
    });
  });
}

function normalizeInput(input: ShellToolInput): ShellToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("shell input must be an object");
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const { command, timeout, cwd } = rawInput;

  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("shell requires a non-empty string command");
  }

  if (timeout !== undefined && !Number.isInteger(timeout)) {
    throw new Error("shell timeout must be an integer when provided");
  }

  if (cwd !== undefined && typeof cwd !== "string") {
    throw new Error("shell cwd must be a string when provided");
  }

  return {
    command,
    timeout: timeout as number | undefined,
    cwd: cwd as string | undefined,
  };
}

function normalizeTimeout(timeout: number | undefined): number {
  if (timeout === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  if (timeout <= 0) {
    throw new Error("shell timeout must be greater than zero");
  }

  return Math.min(timeout, MAX_TIMEOUT_MS);
}

function resolveCwdInsideBase(inputCwd: string, baseCwd: string): string {
  const resolved = path.resolve(baseCwd, inputCwd);
  const relative = path.relative(baseCwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Shell cwd escapes the working directory: ${inputCwd}`);
  }

  return resolved;
}

function appendTruncated(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= MAX_OUTPUT_CHARS) {
    return combined;
  }

  return `${combined.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
}
