/**
 * LLM API client abstraction.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AnthropicClient } from "./anthropic.js";
import { fetchWithRetry } from "./retry.js";
import { extractToolCalls } from "./tool-call-parser.js";

const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_DEFAULT_MODEL = "glm-5.2";
// glm-5.2 is a reasoning model: completion tokens are split between
// `reasoning_content` (chain-of-thought) and `content` (the answer). A low cap
// starves the answer (finish_reason "length"), so default to a generous budget.
const ZAI_DEFAULT_MAX_TOKENS = 16_384;

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
  /** Reasoning/chain-of-thought text, when the model exposes it (e.g. glm-5.2). */
  reasoning?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Incremental token from a streaming completion. */
export interface LlmStreamDelta {
  text?: string;
  reasoning?: string;
}

export interface CompleteOptions {
  /**
   * When provided, the client streams the response and invokes this for each
   * token. Note: once the first delta has fired, a mid-stream failure is NOT
   * transparently retried (no duplicate tokens) — it surfaces to the caller.
   */
  onDelta?: (delta: LlmStreamDelta) => void;
}

export interface LlmClient {
  /** Send messages and return the model's response. */
  complete(
    messages: LlmMessage[],
    tools?: ToolDefinition[],
    options?: CompleteOptions,
  ): Promise<LlmResponse>;
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

  async complete(
    messages: LlmMessage[],
    tools: ToolDefinition[] = [],
    options: CompleteOptions = {},
  ): Promise<LlmResponse> {
    if (options.onDelta) {
      return this.completeStreaming(messages, tools, options.onDelta);
    }

    const response = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.requestBody(messages, tools, false),
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
      reasoning: message.reasoning_content || undefined,
    };
  }

  /**
   * Streaming completion. fetchWithRetry covers pre-stream (connection/status)
   * retries; once the body starts and the first delta fires, a mid-stream
   * failure surfaces to the caller rather than being silently re-streamed.
   */
  private async completeStreaming(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    onDelta: (delta: LlmStreamDelta) => void,
  ): Promise<LlmResponse> {
    const response = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...this.headers(), Accept: "text/event-stream" },
      body: this.requestBody(messages, tools, true),
    });

    if (!response.ok || !response.body) {
      const errorText = response.body ? await response.text() : "";
      throw new Error(`Z.ai API request failed (${response.status}): ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let deltaEmitted = false;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) {
            continue;
          }
          const data = trimmed.slice("data:".length).trim();
          if (data === "[DONE]") {
            continue;
          }

          let chunk: ZaiStreamChunk;
          try {
            chunk = JSON.parse(data) as ZaiStreamChunk;
          } catch {
            continue; // skip keep-alives / partial frames
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) {
            continue;
          }
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            onDelta({ reasoning: delta.reasoning_content });
          }
          if (delta.content) {
            content += delta.content;
            deltaEmitted = true;
            onDelta({ text: delta.content });
          }
          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0;
            const entry = toolAcc.get(index) ?? { id: "", name: "", args: "" };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
            toolAcc.set(index, entry);
          }
        }
      }
    } catch (error) {
      if (deltaEmitted) {
        throw new Error(
          `Z.ai stream interrupted after partial output: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }

    const apiToolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) =>
        fromOpenAiToolCall({
          id: entry.id || `call-${Math.random().toString(36).slice(2)}`,
          type: "function",
          function: { name: entry.name, arguments: entry.args },
        }),
      );

    const extracted = extractToolCalls({ toolCalls: apiToolCalls, content, tools });
    return {
      content: extracted.content,
      toolCalls: extracted.toolCalls,
      reasoning: reasoning || undefined,
    };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "Accept-Language": "en-US,en",
    };
  }

  private requestBody(messages: LlmMessage[], tools: ToolDefinition[], stream: boolean): string {
    return JSON.stringify({
      model: this.model,
      messages: messages.map(toOpenAiMessage),
      tools: tools.map(toOpenAiTool),
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: ZAI_DEFAULT_MAX_TOKENS,
      stream,
    });
  }
}

class LocalTestClient implements LlmClient {
  async complete(
    messages: LlmMessage[],
    tools: ToolDefinition[] = [],
    _options: CompleteOptions = {},
  ): Promise<LlmResponse> {
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
      reasoning_content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
  }>;
}

interface ZaiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
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
