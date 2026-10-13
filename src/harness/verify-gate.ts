/**
 * Verification gate.
 *
 * A very common failure mode — especially for cheaper models — is declaring
 * victory after editing files without ever running anything. This pair tracks
 * mutations versus executions and, when the model tries to finish with
 * unverified changes, pushes back ONCE per batch of changes asking it to run
 * the relevant check. (Pre-completion verification is one of the harness-only
 * changes LangChain credits for its Terminal-Bench gains.)
 */

import type { FinalGate, ToolMiddleware } from "../agent/engine.js";
import { isErrorResult } from "../agent/engine.js";

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "edit_anchored", "delete_file"]);

export interface VerifyGate {
  middleware: ToolMiddleware;
  gate: FinalGate;
  /** Whether unverified changes currently exist (exposed for receipts/tests). */
  hasUnverifiedChanges(): boolean;
}

export function createVerifyGate(): VerifyGate {
  let seq = 0;
  let lastMutation = -1;
  let lastRun = -1;
  let nudgedAtMutation = -2;

  const middleware: ToolMiddleware = {
    name: "verification-tracker",
    after({ call, result }) {
      seq += 1;
      if (MUTATING_TOOLS.has(call.name) && !isErrorResult(result)) {
        lastMutation = seq;
      } else if (call.name === "shell") {
        lastRun = seq;
      }
      return undefined;
    },
  };

  const hasUnverifiedChanges = (): boolean => lastMutation > lastRun;

  const gate: FinalGate = {
    name: "verify-gate",
    check() {
      if (!hasUnverifiedChanges() || nudgedAtMutation === lastMutation) {
        return undefined;
      }
      nudgedAtMutation = lastMutation;
      return (
        "You changed files but have not run anything since your last change. Before finishing, run the relevant command, test, or script to verify the result actually works (and fix anything that fails). If you already verified it some other way, say how in one line and finish."
      );
    },
  };

  return { middleware, gate, hasUnverifiedChanges };
}
