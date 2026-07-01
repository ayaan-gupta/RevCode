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
  /** Optional timeout in milliseconds. Defaults to 120000, caps at 600000. */
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
    timeoutMs: normalized.timeout,
    background: normalized.background,
  });
}

function normalizeInput(input: ShellToolInput): ShellToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("shell input must be an object");
  }

  const raw = input as unknown as Record<string, unknown>;
  const { command, timeout, background } = raw;

  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("shell requires a non-empty string command");
  }

  if (timeout !== undefined && !Number.isInteger(timeout)) {
    throw new Error("shell timeout must be an integer when provided");
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
