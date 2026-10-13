/**
 * Universe recorder: checkpoints the universe after every tool call that can
 * change state, so the timeline can be rewound to any step.
 */

import type { ToolMiddleware } from "../agent/engine.js";
import type { Universe } from "./universe.js";

export interface RecorderContext {
  messageCount: number;
  turn: number;
}

export interface RecorderOptions {
  isReadOnly: (toolName: string) => boolean;
  context: () => RecorderContext;
  onError?: (error: unknown) => void;
}

const NEVER_CHECKPOINT = new Set(["update_plan", "use_skill"]);

export function createUniverseRecorder(universe: Universe, options: RecorderOptions): ToolMiddleware {
  return {
    name: "universe-recorder",
    async after({ call, result }) {
      if (options.isReadOnly(call.name) || NEVER_CHECKPOINT.has(call.name)) {
        return undefined;
      }
      try {
        const ctx = options.context();
        const exitCode =
          result && typeof result === "object" && typeof (result as { exitCode?: unknown }).exitCode === "number"
            ? (result as { exitCode: number }).exitCode
            : undefined;
        await universe.checkpoint({
          kind: "tool",
          tool: call.name,
          summary: summarizeCall(call.name, call.arguments),
          messageCount: ctx.messageCount,
          turn: ctx.turn,
          exitCode,
        });
      } catch (error) {
        options.onError?.(error);
      }
      return undefined;
    },
  };
}

export function summarizeCall(tool: string, args: Record<string, unknown>): string {
  if (tool === "shell") {
    return oneLine(String(args.command ?? ""), 90);
  }
  if (typeof args.path === "string") {
    return `${tool} ${args.path}`;
  }
  if (tool === "apply_patch") {
    const files = [...String(args.input ?? args.patch ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
    return `apply_patch ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}`;
  }
  return tool;
}

function oneLine(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/**
 * Trim a conversation to a point that is safe to resume from: never end inside
 * an assistant tool-call whose results are missing (providers reject that).
 */
export function truncateToConsistent<T extends { role: string; toolCalls?: unknown[] }>(
  messages: T[],
  count: number,
): T[] {
  let end = Math.max(1, Math.min(count, messages.length));
  while (end > 1) {
    const last = messages[end - 1];
    if (last.role === "assistant" && (last.toolCalls?.length ?? 0) > 0) {
      end -= 1;
      continue;
    }
    if (last.role === "tool") {
      let start = end - 1;
      while (start > 0 && messages[start - 1].role === "tool") {
        start -= 1;
      }
      const assistant = messages[start - 1];
      const expected = assistant?.role === "assistant" ? (assistant.toolCalls?.length ?? 0) : 0;
      if (end - start < expected) {
        end = start - 1;
        continue;
      }
    }
    break;
  }
  return messages.slice(0, end);
}
