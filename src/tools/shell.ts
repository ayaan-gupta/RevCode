/**
 * Tool: execute a shell command inside the persistent session.
 *
 * Commands run in a single long-lived bash process (see `ShellSession`), so
 * `cd`, exported env, virtualenvs, and backgrounded servers persist across
 * calls. stdout and stderr are merged into one ordered stream.
 */

import { ShellSession, type ShellRunResult } from "./shell-session.js";

export interface ShellToolInput {
  command: string;
  /**
   * Optional timeout in SECONDS (default 120, max 600) — the unit every other
   * agent harness uses, so models guess it right. Values >= 1000 are treated as
   * legacy milliseconds.
   */
  timeout?: number;
  /** Run detached, redirected to a log file, and return immediately. */
  background?: boolean;
}

export interface ShellToolOptions {
  session: ShellSession;
}

export async function execShell(
  input: ShellToolInput,
  options: ShellToolOptions,
): Promise<ShellRunResult> {
  const normalized = normalizeInput(input);
  if (!options.session) {
    throw new Error("shell tool requires an active shell session");
  }
  return options.session.run(normalized.command, {
    timeoutMs: timeoutToMs(normalized.timeout),
    background: normalized.background,
  });
}

/** Seconds by default; anything >= 1000 can only sensibly be milliseconds. */
export function timeoutToMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }
  return timeout >= 1000 ? timeout : timeout * 1000;
}

function normalizeInput(input: ShellToolInput): ShellToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("shell input must be an object");
  }

  const raw = input as unknown as Record<string, unknown>;
  const { command, background } = raw;
  const timeout = raw.timeout ?? raw.timeout_sec;

  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("shell requires a non-empty string command");
  }

  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
    throw new Error("shell timeout must be a positive number of seconds when provided");
  }

  if (background !== undefined && typeof background !== "boolean") {
    throw new Error("shell background must be a boolean when provided");
  }

  return {
    command,
    timeout: timeout as number | undefined,
    background: background as boolean | undefined,
  };
}
