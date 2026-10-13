/**
 * Receipts: an evidence-backed account of what a turn actually did.
 *
 * Agents (especially cheaper ones) say "done" far more readily than they prove
 * it. A receipt lists the commands that ran with their exit codes, the files that
 * really changed (from the universe's snapshots when there is one), whether
 * anything was verified AFTER the last change, and warnings such as editing an
 * existing test file — the classic way to "make tests pass".
 */

import type { ToolMiddleware } from "../agent/engine.js";
import { isErrorResult } from "../agent/engine.js";

export interface CommandRecord {
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  background: boolean;
  /** Looks like a test/build/run check rather than exploration. */
  verification: boolean;
  /** Tool-call sequence number (for "after the last change" ordering). */
  seq: number;
}

export interface ReceiptFile {
  path: string;
  status: "A" | "M" | "D";
  insertions: number;
  deletions: number;
}

export interface Receipt {
  turn: number;
  at: string;
  durationMs: number;
  stopReason: string;
  toolCalls: number;
  toolErrors: number;
  commands: CommandRecord[];
  files: ReceiptFile[];
  /** Test files that already existed and were changed or deleted. */
  testsModified: string[];
  testsAdded: string[];
  verification: {
    ran: boolean;
    afterLastChange: boolean;
    command?: string;
    exitCode?: number | null;
  };
  tokens?: { input: number; output: number };
}

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "edit_anchored", "delete_file"]);

const VERIFY_PATTERNS: RegExp[] = [
  /\b(?:pytest|py\.test|unittest|nosetests|tox|nox)\b/,
  /\bpython3?\s+-m\s+(?:pytest|unittest|doctest|py_compile|compileall)\b/,
  /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:test|check|lint|build|typecheck)\b/,
  /\b(?:vitest|jest|mocha|ava|tsc|eslint|ruff|mypy|pyright)\b/,
  /\b(?:go|cargo|dotnet|mvn|gradle|gradlew)\s+(?:test|check|build|verify|vet|clippy)\b/,
  /\bmake(?:\s+(?:test|check|all|build))?\s*(?:$|[;&|])/,
  /\b(?:ctest|rspec|phpunit|bats|prove)\b/,
  /\bpython3?\s+\S+\.py\b/,
  /\bnode\s+\S+\.(?:m?js|cjs)\b/,
  /\b(?:bash|sh)\s+\S+\.sh\b/,
  /(?:^|[;&|]\s*)\.\/\S+/,
  /\bcurl\b/,
  /\b(?:gcc|g\+\+|clang|rustc|javac)\b/,
];

export function isVerificationCommand(command: string): boolean {
  return VERIFY_PATTERNS.some((pattern) => pattern.test(command));
}

const TEST_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)tests?\//i,
  /(?:^|\/)__tests__\//,
  /(?:^|\/)test_[^/]*\.py$/,
  /_test\.(?:py|go|rs|c|cc|cpp)$/,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /(?:^|\/)conftest\.py$/,
  /Test\.java$/,
];

export function isTestPath(file: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(file));
}

export class ReceiptCollector {
  private seq = 0;
  private commands: CommandRecord[] = [];
  private touched = new Set<string>();
  private lastMutationSeq = -1;
  private toolCalls = 0;
  private toolErrors = 0;

  middleware(): ToolMiddleware {
    return {
      name: "receipts",
      after: ({ call, result, durationMs }) => {
        this.seq += 1;
        this.toolCalls += 1;
        if (isErrorResult(result)) {
          this.toolErrors += 1;
        }

        if (call.name === "shell") {
          const command = String(call.arguments.command ?? "").trim();
          const record = (result ?? {}) as Record<string, unknown>;
          const code = typeof record.exitCode === "number" ? record.exitCode : null;
          this.commands.push({
            command: command.length > 300 ? `${command.slice(0, 297)}…` : command,
            exitCode: code,
            durationMs,
            timedOut: record.timedOut === true,
            background: record.background !== undefined,
            verification: isVerificationCommand(command),
            seq: this.seq,
          });
        } else if (MUTATING_TOOLS.has(call.name) && !isErrorResult(result)) {
          this.lastMutationSeq = this.seq;
          for (const file of touchedPaths(call.name, call.arguments)) {
            this.touched.add(file);
          }
        }
        return undefined;
      },
    };
  }

  /** Paths changed through file tools this turn (fallback when there is no universe). */
  touchedFiles(): string[] {
    return [...this.touched];
  }

  /** Build the receipt and reset for the next turn. */
  finalize(info: {
    turn: number;
    durationMs: number;
    stopReason: string;
    files?: ReceiptFile[];
    existedBefore?: Set<string>;
    tokens?: { input: number; output: number };
  }): Receipt {
    const files: ReceiptFile[] =
      info.files ?? [...this.touched].map((path) => ({ path, status: "M" as const, insertions: 0, deletions: 0 }));

    const testsModified: string[] = [];
    const testsAdded: string[] = [];
    for (const file of files) {
      if (!isTestPath(file.path)) continue;
      const existed = info.existedBefore ? info.existedBefore.has(file.path) : file.status !== "A";
      if (file.status === "A" && !existed) testsAdded.push(file.path);
      else if (existed) testsModified.push(file.path);
    }

    const checks = this.commands.filter((c) => c.verification && !c.background);
    const lastCheck = checks.at(-1);
    const lastCommand = this.commands.at(-1);
    const verification = {
      ran: checks.length > 0,
      afterLastChange: lastCheck ? lastCheck.seq > this.lastMutationSeq : this.lastMutationSeq < 0,
      command: (lastCheck ?? lastCommand)?.command,
      exitCode: (lastCheck ?? lastCommand)?.exitCode,
    };

    const receipt: Receipt = {
      turn: info.turn,
      at: new Date().toISOString(),
      durationMs: info.durationMs,
      stopReason: info.stopReason,
      toolCalls: this.toolCalls,
      toolErrors: this.toolErrors,
      commands: this.commands,
      files,
      testsModified,
      testsAdded,
      verification: files.length === 0 && !lastCheck ? { ...verification, afterLastChange: true } : verification,
      tokens: info.tokens,
    };

    this.seq = 0;
    this.commands = [];
    this.touched = new Set();
    this.lastMutationSeq = -1;
    this.toolCalls = 0;
    this.toolErrors = 0;
    return receipt;
  }
}

function touchedPaths(tool: string, args: Record<string, unknown>): string[] {
  if (typeof args.path === "string") {
    return [args.path.replace(/^\.\//, "")];
  }
  if (tool === "apply_patch") {
    const text = String(args.input ?? args.patch ?? "");
    return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  }
  return [];
}

// --- presentation --------------------------------------------------------------

/** Plain-text receipt (the TUI adds color; exports reuse this). */
export function formatReceipt(receipt: Receipt): string[] {
  const lines: string[] = [];
  const add = receipt.files.reduce((n, f) => n + f.insertions, 0);
  const del = receipt.files.reduce((n, f) => n + f.deletions, 0);
  const fileSummary =
    receipt.files.length === 0
      ? "no files changed"
      : `${receipt.files.length} file${receipt.files.length === 1 ? "" : "s"} changed (+${add} −${del})`;
  const seconds = (receipt.durationMs / 1000).toFixed(1);
  lines.push(`${fileSummary} · ${receipt.commands.length} command${receipt.commands.length === 1 ? "" : "s"} · ${receipt.toolCalls} tool calls · ${seconds}s`);

  const v = receipt.verification;
  if (receipt.files.length > 0 || v.ran) {
    if (v.ran && v.afterLastChange) {
      const ok = v.exitCode === 0;
      lines.push(`${ok ? "✔" : "✘"} last check: ${trim(v.command ?? "", 60)} → exit ${v.exitCode ?? "?"}`);
    } else if (v.ran) {
      lines.push(`⚠ checks ran before the last change, none after — ${trim(v.command ?? "", 50)} → exit ${v.exitCode ?? "?"}`);
    } else if (receipt.files.length > 0) {
      lines.push("⚠ files changed but nothing was run to verify them");
    }
  }
  for (const file of receipt.testsModified) {
    lines.push(`⚠ modified an existing test file: ${file}`);
  }
  if (receipt.stopReason !== "complete") {
    lines.push(`⚠ turn ended early: ${receipt.stopReason}`);
  }
  return lines;
}

function trim(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
