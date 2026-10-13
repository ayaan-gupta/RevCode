/**
 * LLM handoff summary for very long sessions.
 *
 * Rule-based compaction (context.ts) removes the cheap bulk first. When a task
 * is still too large for the window — or the provider rejects a request as too
 * long — the older conversation is replaced by a written handoff: the original
 * task stays verbatim, everything learned and done so far becomes one summary,
 * and the most recent messages are kept as they were.
 */

import type { LlmClient, LlmMessage } from "../llm/client.js";

const TOOL_RESULT_CLIP = 1_200;
const TRANSCRIPT_LIMIT = 90_000;

export const SUMMARY_MARKER = "[Summary of earlier work]";

const SUMMARY_PROMPT = `You are handing an in-progress engineering task to a colleague who cannot see this conversation. Write a handoff summary they can continue from without asking anything.

Cover, in this order:
1. GOAL - the original task and every explicit requirement (exact file names, paths, formats, values, ports, prohibitions).
2. DONE - what has been completed: files created or changed (with paths), commands run and what they showed.
3. LEARNED - facts about the environment, root causes found, errors hit and how they were resolved.
4. REMAINING - what is not finished yet and the single next concrete step.
5. PITFALLS - things that failed or must be avoided.

Be specific and dense: exact paths, identifiers, values and commands. No filler, no apologies.`;

export interface SummarizeResult {
  messages: LlmMessage[];
  /** Estimated tokens saved. */
  removedChars: number;
}

export interface SummarizeOptions {
  /** Most recent messages kept verbatim. */
  keepLast?: number;
  signal?: AbortSignal;
}

/** Index of the first message of the verbatim tail: never starts on an orphaned tool result. */
export function tailStart(messages: LlmMessage[], keepLast: number): number {
  let start = Math.max(1, messages.length - keepLast);
  while (start < messages.length && messages[start].role === "tool") {
    start += 1;
  }
  return start;
}

export async function summarizeHistory(
  llm: LlmClient,
  messages: LlmMessage[],
  options: SummarizeOptions = {},
): Promise<SummarizeResult | undefined> {
  const keepLast = options.keepLast ?? 8;
  const firstUser = messages.findIndex((m, i) => i > 0 && m.role === "user" && !m.content.startsWith("[harness]"));
  const start = tailStart(messages, keepLast);
  if (firstUser === -1 || start <= firstUser + 1) {
    return undefined; // nothing between the task and the tail worth summarizing
  }

  const middle = messages.slice(firstUser + 1, start);
  const transcript = renderTranscript(middle);
  const response = await llm.complete(
    [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: `TASK (verbatim):\n${messages[firstUser].content}\n\nCONVERSATION SO FAR:\n${transcript}\n\nWrite the handoff summary now.` },
    ],
    [],
    { signal: options.signal, temperature: 0.2, maxTokens: 3_000 },
  );
  const summary = response.content.trim();
  if (!summary) {
    return undefined;
  }

  const before = messages.reduce((n, m) => n + m.content.length, 0);
  const next: LlmMessage[] = [
    ...messages.slice(0, firstUser + 1),
    { role: "user", content: `${SUMMARY_MARKER}\n${summary}\n\nContinue from here. The most recent messages follow unchanged.` },
    ...messages.slice(start),
  ];
  const after = next.reduce((n, m) => n + m.content.length, 0);
  return { messages: next, removedChars: Math.max(0, before - after) };
}

function renderTranscript(messages: LlmMessage[]): string {
  const parts: string[] = [];
  let total = 0;
  for (const message of messages) {
    let text: string;
    if (message.role === "assistant") {
      const calls = (message.toolCalls ?? []).map((c) => `${c.name}(${clip(JSON.stringify(c.arguments), 300)})`).join("; ");
      text = `ASSISTANT: ${message.content}${calls ? `\n  calls: ${calls}` : ""}`;
    } else if (message.role === "tool") {
      text = `  RESULT[${message.name ?? "tool"}]: ${clip(unwrap(message.content), TOOL_RESULT_CLIP)}`;
    } else {
      text = `${message.role.toUpperCase()}: ${message.content}`;
    }
    total += text.length;
    if (total > TRANSCRIPT_LIMIT) {
      parts.push("[… earlier part of the conversation omitted for length …]");
      break;
    }
    parts.push(text);
  }
  return parts.join("\n");
}

function unwrap(content: string): string {
  try {
    const parsed = JSON.parse(content) as { result?: unknown };
    const result = parsed.result;
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (typeof r.stdout === "string") return `${r.stdout}${r.exitCode !== undefined ? `\n[exit ${String(r.exitCode)}]` : ""}`;
      if (typeof r.content === "string") return r.content;
      if (typeof r.error === "string") return `Error: ${r.error}`;
    }
    return JSON.stringify(result);
  } catch {
    return content;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** True when an API error means the request exceeded the model's context window. */
export function isContextOverflowError(message: string): boolean {
  return /context[_ ]?(?:length|window)|maximum context|too (?:long|many tokens)|prompt is too long|exceeds? (?:the )?(?:maximum|max|model'?s?)|input.{0,20}too large|reduce the length|token limit/i.test(message);
}
