/**
 * Parse tool calls from LLM responses.
 *
 * Open models often emit tool calls as text in message content when the API does
 * not populate structured tool_calls. Three dialects are understood:
 *   - GLM:        <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
 *   - Hermes/Qwen:<tool_call>{"name": "...", "arguments": {...}}</tool_call>
 *   - Qwen3-Coder:<tool_call><function=name><parameter=k>v</parameter></function></tool_call>
 * plus single-line {"tool_call": {...}} JSON. This module normalizes all paths and
 * strips <think> blocks from the visible content.
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

/** Remove reasoning blocks some servers inline into `content`. */
export function stripThinkBlocks(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();
}

export function extractToolCalls(rawInput: ExtractToolCallsInput): ExtractToolCallsResult {
  const input = rawInput.content.includes("think>")
    ? { ...rawInput, content: stripThinkBlocks(rawInput.content) }
    : rawInput;
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
    const trimmedBody = body.trim();

    // Hermes / Qwen: JSON object with name + arguments.
    if (trimmedBody.startsWith("{")) {
      const call = parseHermesJson(trimmedBody);
      if (call) calls.push(call);
      continue;
    }

    // Qwen3-Coder: <function=name><parameter=key>value</parameter>…</function>
    const fn = body.match(/<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/);
    if (fn) {
      const name = fn[1].trim();
      const args: Record<string, unknown> = {};
      for (const param of fn[2].matchAll(/<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g)) {
        // Qwen wraps values in newlines; one leading and trailing newline is formatting, not content.
        const raw = param[2].replace(/^\n/, "").replace(/\n$/, "");
        args[param[1].trim()] = coerceArgumentValue(name, param[1].trim(), raw, tools);
      }
      calls.push({ id: nextToolCallId(), name, arguments: args });
      continue;
    }

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

function parseHermesJson(text: string): LlmToolCall | undefined {
  try {
    const parsed = JSON.parse(text) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof parsed.name !== "string" || parsed.name.length === 0) {
      return undefined;
    }
    let args: unknown = parsed.arguments ?? parsed.parameters ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = { input: args };
      }
    }
    return {
      id: nextToolCallId(),
      name: parsed.name,
      arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
    };
  } catch {
    return undefined;
  }
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
