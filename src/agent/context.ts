/**
 * Lightweight context management: token estimation and rule-based compaction.
 *
 * Long TerminalBench tasks accumulate large tool outputs that crowd out the
 * model's context window. Compaction summarizes OLD, LOW-VALUE tool results
 * (exploratory reads/searches/listings, stale successful shell output) while
 * preserving everything load-bearing: the system prompt, recent turns, all
 * mutations, all errors, and any output that was referenced again later.
 *
 * Compaction is rule-based (no extra LLM call) to avoid added latency.
 */

import type { LlmMessage } from "../llm/client.js";

/** Heuristic token estimate (≈ 4 chars/token) over the whole message list. */
export function estimateTokens(messages: LlmMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content?.length ?? 0;
    for (const call of message.toolCalls ?? []) {
      chars += call.name.length + JSON.stringify(call.arguments).length;
    }
  }
  return Math.ceil(chars / 4);
}

export interface CompactionOptions {
  /** Estimated-token budget for the model's context window. */
  tokenLimit?: number;
  /** Fraction of the limit at which compaction triggers. */
  triggerRatio?: number;
  /** Most recent messages always kept verbatim. */
  keepLastN?: number;
}

const DEFAULTS = {
  tokenLimit: 120_000,
  triggerRatio: 0.7,
  keepLastN: 20,
};

const COMPACTABLE_TOOLS = new Set(["read_file", "grep", "glob", "list_directory"]);

export interface CompactionResult {
  messages: LlmMessage[];
  compacted: boolean;
  removedTokens: number;
}

/** Compact if over the trigger threshold; otherwise return messages unchanged. */
export function maybeCompact(
  messages: LlmMessage[],
  options: CompactionOptions = {},
): CompactionResult {
  const cfg = { ...DEFAULTS, ...options };
  const before = estimateTokens(messages);
  if (before <= cfg.tokenLimit * cfg.triggerRatio) {
    return { messages, compacted: false, removedTokens: 0 };
  }
  return forceCompact(messages, options);
}

/** Always run a compaction pass (used by `/compact`). */
export function forceCompact(
  messages: LlmMessage[],
  options: CompactionOptions = {},
): CompactionResult {
  const cfg = { ...DEFAULTS, ...options };
  const before = estimateTokens(messages);
  const cutoff = Math.max(1, messages.length - cfg.keepLastN);

  // Paths referenced anywhere after their producing message stay verbatim.
  const referencedAfter = buildReferenceIndex(messages);

  let changed = false;
  const out = messages.map((message, index) => {
    if (index === 0 || index >= cutoff || message.role !== "tool") {
      return message; // system, recent, or non-tool: keep verbatim
    }

    const parsed = parseToolMessage(message);
    if (!parsed || !COMPACTABLE_TOOLS.has(parsed.name)) {
      return message; // mutations/shell/errors handled by isLowValue below
    }
    if (!isLowValue(parsed.result)) {
      return message; // e.g. a read that errored
    }

    const targetPath = extractPath(parsed.result);
    if (targetPath && referencedAfter(targetPath, index)) {
      return message; // load-bearing later — keep full
    }

    changed = true;
    return summarizeToolMessage(message, parsed, targetPath);
  });

  if (!changed) {
    return { messages, compacted: false, removedTokens: 0 };
  }
  const after = estimateTokens(out);
  return { messages: out, compacted: true, removedTokens: Math.max(0, before - after) };
}

// --- internals -------------------------------------------------------------

interface ParsedToolMessage {
  toolCallId?: string;
  name: string;
  result: unknown;
}

function parseToolMessage(message: LlmMessage): ParsedToolMessage | undefined {
  try {
    const parsed = JSON.parse(message.content) as {
      toolCallId?: string;
      name?: string;
      result?: unknown;
    };
    if (!parsed.name) {
      return undefined;
    }
    return { toolCallId: parsed.toolCallId, name: parsed.name, result: parsed.result };
  } catch {
    return undefined;
  }
}

/** Low-value = a successful, non-error read/search/listing result. */
function isLowValue(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const record = result as Record<string, unknown>;
  if (record.error) {
    return false; // errors are always kept
  }
  return true;
}

function extractPath(result: unknown): string | undefined {
  if (result && typeof result === "object") {
    const path = (result as Record<string, unknown>).path;
    if (typeof path === "string" && path.length > 0) {
      return path;
    }
  }
  return undefined;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * Returns a predicate `(path, producedAtIndex) => referencedLater`. Matching is
 * a case-insensitive substring test on BOTH the full path and its basename
 * against every later message's content and tool-call arguments — catching the
 * model referring to the same file by relative path once and absolute another.
 */
function buildReferenceIndex(
  messages: LlmMessage[],
): (path: string, producedAtIndex: number) => boolean {
  const lower = messages.map((m) => {
    let text = (m.content ?? "").toLowerCase();
    for (const call of m.toolCalls ?? []) {
      text += " " + JSON.stringify(call.arguments).toLowerCase();
    }
    return text;
  });

  return (path: string, producedAtIndex: number) => {
    const full = path.toLowerCase();
    const base = basename(path).toLowerCase();
    for (let i = producedAtIndex + 1; i < messages.length; i += 1) {
      if (lower[i].includes(full) || lower[i].includes(base)) {
        return true;
      }
    }
    return false;
  };
}

function summarizeToolMessage(
  message: LlmMessage,
  parsed: ParsedToolMessage,
  targetPath: string | undefined,
): LlmMessage {
  const summary = buildSummary(parsed, targetPath);
  return {
    ...message,
    content: JSON.stringify({
      toolCallId: parsed.toolCallId,
      name: parsed.name,
      result: { compacted: true, summary },
    }),
  };
}

function buildSummary(parsed: ParsedToolMessage, targetPath: string | undefined): string {
  const record = (parsed.result ?? {}) as Record<string, unknown>;
  switch (parsed.name) {
    case "read_file": {
      const lines = record.totalLines ?? record.lines;
      const where = targetPath ? ` ${targetPath}` : "";
      const size = lines ? ` (${lines} lines)` : "";
      return `Read${where}${size}; content elided — re-read the file if you need it again.`;
    }
    case "list_directory":
      return `Listed ${targetPath ?? "directory"}; entries elided — list again if needed.`;
    case "grep":
      return "grep results elided — re-run the search if needed.";
    case "glob":
      return "glob results elided — re-run the search if needed.";
    default:
      return "Tool output elided to save context.";
  }
}
