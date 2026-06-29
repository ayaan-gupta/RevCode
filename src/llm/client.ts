/**
 * LLM API client abstraction.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AnthropicClient } from "./anthropic.js";
import { extractToolCalls } from "./tool-call-parser.js";

const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_DEFAULT_MODEL = "glm-4.5";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmClient {
  /** Send messages and return the model's response. */
  complete(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export type LlmProvider = "zai" | "anthropic" | "local-test";

export interface CreateLlmClientOptions {
  model: string;
  provider?: LlmProvider;
}

export function createLlmClient(modelOrOptions: string | CreateLlmClientOptions): LlmClient {
  loadDotEnv();

  const options =
    typeof modelOrOptions === "string"
      ? { model: modelOrOptions, provider: undefined as LlmProvider | undefined }
      : modelOrOptions;

  const provider = resolveProvider(options.provider, options.model);

  if (provider === "local-test") {
    return new LocalTestClient();
  }

  if (provider === "anthropic") {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required to use the Anthropic provider");
    }
    return new AnthropicClient(options.model, apiKey);
  }

  const apiKey = getZaiApiKey();
  if (!apiKey) {
    throw new Error(
      `No LLM client configured for model: ${options.model}. Set Z_AI_API_KEY or use --provider local-test.`,
    );
  }

  return new ZaiClient(options.model || ZAI_DEFAULT_MODEL, apiKey);
}

function resolveProvider(provider: LlmProvider | undefined, model: string): LlmProvider {
  if (provider) {
    return provider;
  }

  if (model === "local-test" || model === "test") {
    return "local-test";
  }

  if (getAnthropicApiKey() && !getZaiApiKey()) {
    return "anthropic";
  }

  return "zai";
}

class ZaiClient implements LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(model: string, apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(
      process.env.Z_AI_BASE_URL ?? process.env.ZAI_BASE_URL ?? ZAI_DEFAULT_BASE_URL,
    );
    this.model = model;
  }

  async complete(messages: LlmMessage[], tools: ToolDefinition[] = []): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en",
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(toOpenAiMessage),
        tools: tools.map(toOpenAiTool),
        tool_choice: "auto",
        temperature: 0.2,
      }),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Z.ai API request failed (${response.status}): ${responseText}`);
    }

    const payload = JSON.parse(responseText) as ZaiChatCompletionResponse;
    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new Error("Z.ai API response did not include a message");
    }

    const apiToolCalls = (message.tool_calls ?? []).map(fromOpenAiToolCall);
    const extracted = extractToolCalls({
      toolCalls: apiToolCalls,
      content: message.content ?? "",
      tools,
    });

    if (extracted.usedFallback) {
      console.warn(
        "[revcode] Parsed tool calls from assistant content fallback (XML/inline JSON).",
      );
    }

    return {
      content: extracted.content,
      toolCalls: extracted.toolCalls,
    };
  }
}

class LocalTestClient implements LlmClient {
  async complete(messages: LlmMessage[], tools: ToolDefinition[] = []): Promise<LlmResponse> {
    const lastMessage = messages.at(-1);
    if (!lastMessage) {
      return {
        content: "No messages were provided.",
        toolCalls: [],
      };
    }

    if (lastMessage.role === "tool") {
      return {
        content: formatToolResult(lastMessage.content),
        toolCalls: [],
      };
    }

    if (lastMessage.role !== "user") {
      return {
        content: "",
        toolCalls: [],
      };
    }

    const parsedToolCall = parseLocalToolCommand(lastMessage.content, tools);
    if (parsedToolCall instanceof Error) {
      return {
        content: parsedToolCall.message,
        toolCalls: [],
      };
    }

    if (parsedToolCall) {
      return {
        content: "",
        toolCalls: [parsedToolCall],
      };
    }

    return {
      content: localHelp(tools),
      toolCalls: [],
    };
  }
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ZaiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
  }>;
}

function toOpenAiMessage(message: LlmMessage): OpenAiMessage {
  if (message.role === "assistant") {
    const openAiMessage: OpenAiMessage = {
      role: "assistant",
      content: message.content || null,
    };

    if (message.toolCalls && message.toolCalls.length > 0) {
      openAiMessage.tool_calls = message.toolCalls.map(toOpenAiToolCall);
    }

    return openAiMessage;
  }

  if (message.role === "tool") {
    const parsedToolResult = parseToolResultMessage(message);
    return {
      role: "tool",
      content: parsedToolResult.content,
      tool_call_id: parsedToolResult.toolCallId,
      name: parsedToolResult.name,
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function toOpenAiTool(tool: ToolDefinition): OpenAiTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toOpenAiToolCall(toolCall: LlmToolCall): OpenAiToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments),
    },
  };
}

function fromOpenAiToolCall(toolCall: OpenAiToolCall): LlmToolCall {
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: parseToolArguments(toolCall.function.arguments),
  };
}

function parseToolArguments(rawArguments: string): Record<string, unknown> {
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

function parseToolResultMessage(message: LlmMessage): {
  content: string;
  toolCallId: string;
  name?: string;
} {
  if (message.toolCallId) {
    return {
      content: message.content,
      toolCallId: message.toolCallId,
      name: message.name,
    };
  }

  try {
    const parsed = JSON.parse(message.content) as {
      toolCallId?: string;
      name?: string;
      result?: unknown;
    };

    return {
      content: JSON.stringify(parsed.result ?? parsed),
      toolCallId: parsed.toolCallId ?? "unknown-tool-call",
      name: parsed.name,
    };
  } catch {
    return {
      content: message.content,
      toolCallId: "unknown-tool-call",
    };
  }
}

function getZaiApiKey(): string | undefined {
  return process.env.Z_AI_API_KEY ?? process.env.ZAI_API_KEY;
}

function getAnthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1).trim());
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseLocalToolCommand(
  content: string,
  tools: ToolDefinition[],
): LlmToolCall | Error | null {
  const trimmed = content.trim();
  const match = trimmed.match(/^\/tool\s+([a-zA-Z0-9_-]+)\s+([\s\S]+)$/);
  if (!match) {
    return null;
  }

  const [, name, rawArguments] = match;
  if (!tools.some((tool) => tool.name === name)) {
    return {
      id: `local-${Date.now()}`,
      name,
      arguments: {},
    };
  }

  const parsedArguments = parseJsonArguments(rawArguments);
  if (parsedArguments instanceof Error) {
    return parsedArguments;
  }

  return {
    id: `local-${Date.now()}`,
    name,
    arguments: parsedArguments,
  };
}

function parseJsonArguments(rawArguments: string): Record<string, unknown> | Error {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return new Error("Tool arguments must be a JSON object.");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    return new Error(
      `Invalid tool JSON arguments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatToolResult(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      name?: string;
      result?: unknown;
      toolCallId?: string;
    };

    return `Tool result for ${parsed.name ?? parsed.toolCallId ?? "tool"}:\n${JSON.stringify(
      parsed.result,
      null,
      2,
    )}`;
  } catch {
    return `Tool result:\n${content}`;
  }
}

function localHelp(tools: ToolDefinition[]): string {
  const toolNames = tools.map((tool) => tool.name).join(", ");
  return [
    "Local test client is active.",
    "Call a tool with: /tool <tool_name> <json_arguments>",
    `Available tools: ${toolNames || "(none)"}`,
    'Example: /tool read_file {"path":"README.md","limit":5}',
  ].join("\n");
}
