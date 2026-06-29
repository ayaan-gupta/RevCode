/**
 * Parse tool calls from LLM responses.
 *
 * GLM models may emit XML-style tool calls in message content when the API
 * does not populate structured tool_calls. This module normalizes both paths.
 */

import type { LlmToolCall } from "./client.js";

export interface ToolDefinitionRef {
  name: string;
  parameters: Record<string, unknown>;
}

export interface ExtractToolCallsInput {
  toolCalls: LlmToolCall[];
  content: string;
  tools: ToolDefinitionRef[];
}

export interface ExtractToolCallsResult {
  toolCalls: LlmToolCall[];
  content: string;
  usedFallback: boolean;
}

let toolCallIdCounter = 0;

function nextToolCallId(): string {
  toolCallIdCounter += 1;
  return `parsed-tool-call-${Date.now()}-${toolCallIdCounter}`;
}

export function extractToolCalls(input: ExtractToolCallsInput): ExtractToolCallsResult {
  if (input.toolCalls.length > 0) {
    return {
      toolCalls: input.toolCalls,
      content: stripToolMarkup(input.content),
      usedFallback: false,
    };
  }

  const inlineJsonCalls = parseInlineJsonToolCalls(input.content);
  if (inlineJsonCalls.length > 0) {
    return {
      toolCalls: inlineJsonCalls,
      content: stripInlineJsonToolCalls(input.content),
      usedFallback: true,
    };
  }

  const xmlCalls = parseGlmXmlToolCalls(input.content, input.tools);
  if (xmlCalls.length > 0) {
    return {
      toolCalls: xmlCalls,
      content: stripGlmXmlToolCalls(input.content),
      usedFallback: true,
    };
  }

  return {
    toolCalls: [],
    content: input.content,
    usedFallback: false,
  };
}

export function parseGlmXmlToolCalls(
  content: string,
  tools: ToolDefinitionRef[],
): LlmToolCall[] {
  const calls: LlmToolCall[] = [];
  const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;

  for (const match of content.matchAll(pattern)) {
    const body = match[1] ?? "";
    const nameMatch = body.match(/^\s*([^\n<]+)/);
    if (!nameMatch) {
      continue;
    }

    const name = nameMatch[1].trim();
    const argPattern = /<arg_key>([\s\S]*?)<\/arg_key>\s*(?:\\n|\n|\s)*<arg_value>([\s\S]*?)<\/arg_value>/g;
    const arguments_: Record<string, unknown> = {};

    for (const argMatch of body.matchAll(argPattern)) {
      const key = (argMatch[1] ?? "").trim();
      let value: unknown = (argMatch[2] ?? "").trim();
      if (key) {
        value = coerceArgumentValue(name, key, value, tools);
        arguments_[key] = value;
      }
    }

    calls.push({
      id: nextToolCallId(),
      name,
      arguments: arguments_,
    });
  }

  return calls;
}

export function parseInlineJsonToolCalls(content: string): LlmToolCall[] {
  const calls: LlmToolCall[] = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"tool_call"')) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as {
        tool_call?: { name?: string; arguments?: Record<string, unknown> };
      };
      const toolCall = parsed.tool_call;
      if (!toolCall?.name || typeof toolCall.name !== "string") {
        continue;
      }

      calls.push({
        id: nextToolCallId(),
        name: toolCall.name,
        arguments:
          typeof toolCall.arguments === "object" && toolCall.arguments !== null
            ? toolCall.arguments
            : {},
      });
    } catch {
      // Ignore malformed JSON lines.
    }
  }

  return calls;
}

function coerceArgumentValue(
  funcName: string,
  argKey: string,
  rawValue: unknown,
  tools: ToolDefinitionRef[],
): unknown {
  if (typeof rawValue !== "string") {
    return rawValue;
  }

  const argType = getArgumentType(funcName, argKey, tools);
  if (argType === "string") {
    return rawValue;
  }

  try {
    return JSON.parse(rawValue) as unknown;
  } catch {
    return rawValue;
  }
}

function getArgumentType(
  funcName: string,
  argKey: string,
  tools: ToolDefinitionRef[],
): string | undefined {
  const tool = tools.find((entry) => entry.name === funcName);
  if (!tool) {
    return undefined;
  }

  const properties = tool.parameters.properties as Record<string, { type?: string }> | undefined;
  return properties?.[argKey]?.type;
}

function stripGlmXmlToolCalls(content: string): string {
  return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
}

function stripInlineJsonToolCalls(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") || !trimmed.includes('"tool_call"')) {
        return true;
      }
      try {
        const parsed = JSON.parse(trimmed) as { tool_call?: unknown };
        return parsed.tool_call === undefined;
      } catch {
        return true;
      }
    })
    .join("\n")
    .trim();
}

function stripToolMarkup(content: string): string {
  const withoutXml = stripGlmXmlToolCalls(content);
  return stripInlineJsonToolCalls(withoutXml);
}
