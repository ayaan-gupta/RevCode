/**
 * Completion challenge.
 *
 * Cheaper models routinely declare victory early or "verify" their own code
 * instead of the original request. When a run that used tools tries to finish,
 * this gate pushes back with the ORIGINAL task text and a short audit procedure
 * (requirements → evidence → clean final state). If the audit leads the model to
 * CHANGE something it may be challenged again, up to a small cap; if it only
 * re-checks (reads, lists, runs tests) the run ends — a second audit of an
 * unchanged result just burns model calls. Cost: one extra audit round per task.
 */

import type { FinalGate, ToolMiddleware } from "../agent/engine.js";
import { isErrorResult } from "../agent/engine.js";
import { classifyShellCommand } from "../agent/shell-classify.js";

const MAX_TASK_CHARS = 3_000;

const FILE_MUTATING_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "edit_anchored", "delete_file"]);

/** Verbs and redirections that change files or installed state (not exhaustive: a fix made some other way just isn't re-audited). */
const MUTATING_SHELL =
  /(?:^|[\s;&|(])(?:rm|mv|cp|mkdir|touch|truncate|ln|chmod|chown|tee|patch|install|kill|pkill)\b|\bsed\s+(?:-\w*\s+)*-\w*i|\bgit\s+(?:checkout|reset|clean|apply|commit|restore|stash|merge|rebase)\b|\b(?:pip3?|npm|yarn|pnpm|apt(?:-get)?|cargo|go)\s+(?:install|add|get)\b|\d?>>?\s*(?!&|\/dev\/null)\S/;

/** Did this call change the project — as opposed to inspecting or running it? */
export function isMutatingCall(name: string, args: unknown): boolean {
  if (FILE_MUTATING_TOOLS.has(name)) {
    return true;
  }
  if (name !== "shell" && name !== "terminal") {
    return false;
  }
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const command = typeof record.command === "string" ? record.command : typeof record.keys === "string" ? record.keys : "";
  return command !== "" && classifyShellCommand(command) !== "safe" && MUTATING_SHELL.test(command);
}

export interface CompletionGate {
  gate: FinalGate;
  /** Tracks tool activity so a challenge that led to fixes can be repeated. */
  middleware: ToolMiddleware;
  /** Set the task text the next challenge will quote (interactive turns). */
  setTask(task: string): void;
}

/**
 * @param isReadOnly tools that cannot change anything; a turn that only used
 *   those (a question, an exploration) has nothing to audit and is never challenged.
 */
export function createCompletionGate(
  initialTask: string,
  maxChallenges = 2,
  isReadOnly: (toolName: string) => boolean = () => false,
): CompletionGate {
  let task = initialTask;
  let challenges = 0;
  let activitySinceChallenge = false;
  /** Any non-read-only call before the first challenge; only real changes after it. */
  const countsAsActivity = (name: string, args: unknown, failed: boolean): boolean =>
    challenges === 0 ? !isReadOnly(name) : !failed && isMutatingCall(name, args);

  return {
    setTask(next: string) {
      task = next;
      challenges = 0;
      activitySinceChallenge = false;
    },
    middleware: {
      name: "completion-activity",
      after({ call, result }) {
        if (countsAsActivity(call.name, call.arguments, isErrorResult(result))) {
          activitySinceChallenge = true;
        }
        return undefined;
      },
    },
    gate: {
      name: "completion-gate",
      check() {
        if (challenges >= maxChallenges || !activitySinceChallenge) {
          return undefined;
        }
        challenges += 1;
        activitySinceChallenge = false;
        return challengeMessage(task);
      },
    },
  };
}

export function challengeMessage(task: string): string {
  const quoted = task.length > MAX_TASK_CHARS ? `${task.slice(0, MAX_TASK_CHARS)}\n…(task truncated)` : task;
  return [
    "Before you finish, audit your work against the ORIGINAL task:",
    "",
    "<task>",
    quoted,
    "</task>",
    "",
    "1. List every explicit requirement above (each file/path, name, format, value, port, ordering, and prohibition).",
    "2. For each one, prove it holds RIGHT NOW with a command or by opening the file — do not rely on what you remember doing.",
    "3. Check the end state is clean: remove scratch files you created, and leave no stray processes unless the task needs them running.",
    "4. If anything is missing or unverified, fix it now and re-check. If everything is satisfied, reply with a brief final summary.",
    "",
    "Your work is graded after this reply and cannot be changed afterwards.",
  ].join("\n");
}
