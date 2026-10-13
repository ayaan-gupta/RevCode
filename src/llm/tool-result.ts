/**
 * Helpers shared by every provider adapter for the agent's tool-call wire
 * format: tool results arrive as `role: "tool"` messages whose content is the
 * JSON envelope `{ toolCallId, name, result }`, and model-emitted arguments
 * arrive as JSON strings that may be empty or malformed.
 */

import { renderToolResult } from "../harness/render-result.js";
import type { LlmMessage } from "./client.js";

export interface ParsedToolResult {
  /** What the model should read: the result rendered as plain text. */
  content: string;
  toolCallId: string;
  name?: string;
  /** The result is an object with a string `error` field (tool failed/denied). */
  isError: boolean;
}

/**
 * Unwraps the `{ toolCallId, name, result }` envelope and renders `result` as
 * plain text. JSON-stringifying it would escape every newline and quote, which
 * makes models mis-copy file contents they just read. Content that is not an
 * envelope is forwarded untouched.
 */
export function parseToolResultMessage(message: LlmMessage): ParsedToolResult {
  const envelope = parseEnvelope(message.content);
  const toolCallId = message.toolCallId ?? envelope?.toolCallId ?? "unknown-tool-call";
  const name = message.name ?? envelope?.name;

  if (!envelope) {
    return { content: message.content, toolCallId, name, isError: false };
  }

  if (!envelope.hasResult) {
    return { content: message.content, toolCallId, name, isError: hasStringError(envelope.raw) };
  }

  return {
    content: renderToolResult(name, envelope.result),
    toolCallId,
    name,
    isError: hasStringError(envelope.result),
  };
}

/**
 * Tool-call arguments as produced by the model. Unparseable JSON is preserved
 * under `input` so the agent can report it back to the model instead of
 * silently running the tool with no arguments.
 */
export function parseToolArguments(rawArguments: string): Record<string, unknown> {
  if (rawArguments.trim() === "") {
    return {}; // tools without parameters stream no argument text at all
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to preserve the raw string for debuggability.
  }

  return { input: rawArguments };
}

interface ToolResultEnvelope {
  toolCallId?: string;
  name?: string;
  result?: unknown;
  /** The object had a `result` key (its value may legitimately be null). */
  hasResult: boolean;
  raw: Record<string, unknown>;
}

function parseEnvelope(content: string): ToolResultEnvelope | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return {
      toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      result: record.result,
      hasResult: "result" in record,
      raw: record,
    };
  } catch {
    return undefined;
  }
}

function hasStringError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).error === "string"
  );
}
