/**
 * Single-keypress permission prompt.
 *
 * Reads one key in raw mode (y / n / a, Enter = yes, Esc / Ctrl-C = no) so the
 * user never has to type a line to answer. Anything else is ignored. With no TTY
 * there is nobody to ask, so the answer is "deny".
 */

import { stdin as input } from "node:process";
import * as readline from "node:readline";
import type { ApprovalAnswer, ApprovalRequest } from "../agent/permissions.js";
import type { TerminalRenderer } from "./render.js";

export function interpretApprovalKey(char: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): ApprovalAnswer | undefined {
  if (key?.ctrl && key.name === "c") return "deny";
  if (key?.name === "escape") return "deny";
  if (key?.name === "return") return "allow";
  switch ((char ?? "").toLowerCase()) {
    case "y":
      return "allow";
    case "n":
      return "deny";
    case "a":
      return "always";
    default:
      return undefined;
  }
}

export function createTerminalApprover(renderer: TerminalRenderer): (request: ApprovalRequest) => Promise<ApprovalAnswer> {
  return async (request) => {
    if (!input.isTTY) {
      return "deny";
    }
    renderer.approvalRequest(request.summary, request.reason);

    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();

    const answer = await new Promise<ApprovalAnswer>((resolve) => {
      const onKey = (char: string | undefined, key: readline.Key): void => {
        const decided = interpretApprovalKey(char, key);
        if (decided) {
          input.removeListener("keypress", onKey);
          resolve(decided);
        }
      };
      input.on("keypress", onKey);
    });

    input.setRawMode?.(wasRaw ?? false);
    renderer.approvalAnswered(answer === "allow" ? "yes" : answer === "always" ? "always" : "no");
    return answer;
  };
}
