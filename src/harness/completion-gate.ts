/**
 * Completion challenge.
 *
 * Cheaper models routinely declare victory early or "verify" their own code
 * instead of the original request. When a run that used tools tries to finish,
 * this gate pushes back with the ORIGINAL task text and a short audit procedure
 * (requirements → evidence → clean final state). If the model then fixes
 * something it may be challenged again, up to a small cap; if it simply
 * confirms, the run ends. Cost: one extra model call per task.
 */

import type { FinalGate, ToolMiddleware } from "../agent/engine.js";

const MAX_TASK_CHARS = 3_000;

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

  return {
    setTask(next: string) {
      task = next;
      challenges = 0;
      activitySinceChallenge = false;
    },
    middleware: {
      name: "completion-activity",
      after({ call }) {
        if (!isReadOnly(call.name)) {
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
