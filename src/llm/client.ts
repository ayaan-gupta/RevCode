/**
 * LLM client abstraction and provider selection.
 *
 * `createLlmClient` maps a provider name to a concrete client:
 *
 *   zai, openai, openrouter, ollama, openai-compat  -> OpenAiCompatClient
 *   anthropic                                       -> AnthropicClient
 *   local-test                                      -> LocalTestClient (offline)
 *
 * Environment (a `.env` in the working directory is loaded without overriding
 * variables that are already set; empty values count as unset):
 *
 *   Z_AI_API_KEY | ZAI_API_KEY, Z_AI_BASE_URL | ZAI_BASE_URL   zai
 *   ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL                      anthropic
 *   OPENAI_API_KEY, OPENAI_BASE_URL                            openai
 *   OPENROUTER_API_KEY                                         openrouter
 *   OLLAMA_HOST (default http://localhost:11434)               ollama
 *   REVCODE_BASE_URL (required), REVCODE_API_KEY (optional)    openai-compat
 *   REVCODE_LLM_TIMEOUT_MS                                     all network providers
 *   REVCODE_NO_CACHE=1                                         disables Anthropic prompt caching
 *
 * `CreateLlmClientOptions.baseUrl` / `apiKey` take precedence over the above.
 */

import { loadEnvFiles } from "../config/env.js";
import { AnthropicClient } from "./anthropic.js";
import { OpenAiCompatClient, type OpenAiCompatConfig } from "./openai-compat.js";
import type { ImageQuestion } from "./vision.js";

const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_DEFAULT_MODEL = "glm-5.2";
const ZAI_DEFAULT_VISION_MODEL = "glm-4.6v";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const OLLAMA_DEFAULT_HOST = "http://localhost:11434";
const OLLAMA_DEFAULT_PORT = "11434";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface LlmUsage {
  /**
   * Whole prompt size in tokens, INCLUDING any tokens read from or written to
   * the provider's prompt cache (so it is comparable across providers).
   */
  inputTokens: number;
  outputTokens: number;
  /** Subset of `inputTokens` served from the provider's prompt cache, when reported. */
  cachedInputTokens?: number;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  /** Reasoning/chain-of-thought text, when the model exposes it (e.g. glm-5.2). */
  reasoning?: string;
  /** Token accounting reported by the provider (best effort). */
  usage?: LlmUsage;
  /**
   * Why generation ended, normalized where possible: "stop" (natural end),
   * "length" (hit the token limit, output may be truncated) or "tool_calls".
   * Other provider-specific values (e.g. "content_filter") pass through.
   */
  finishReason?: string;
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
  /**
   * Abort the in-flight request (user interrupt). The call rejects with an
   * Error whose `name` is "AbortError" and is never retried.
   */
  signal?: AbortSignal;
  /**
   * Sampling temperature override (harness profile). Ignored for models that
   * reject sampling parameters (current Claude models).
   */
  temperature?: number;
  /** Max completion tokens override (harness profile); default 16384. */
  maxTokens?: number;
  /** "off" disables chain-of-thought where the provider has a switch (Z.ai); ignored elsewhere. */
  thinking?: "on" | "off";
}

export interface LlmClient {
  /** Send messages and return the model's response. */
  complete(
    messages: LlmMessage[],
    tools?: ToolDefinition[],
    options?: CompleteOptions,
  ): Promise<LlmResponse>;

  /**
   * Answer a question about an image with a vision model. Present only when
   * the provider has one configured (a text-only main model gets a companion
   * vision model, e.g. Z.ai's glm-4.6v); the `view_image` tool depends on it.
   */
  describeImage?(image: ImageQuestion, options?: { signal?: AbortSignal }): Promise<string>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export const LLM_PROVIDERS = [
  "zai",
  "anthropic",
  "openai",
  "openrouter",
  "ollama",
  "openai-compat",
  "local-test",
] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

export interface CreateLlmClientOptions {
  model: string;
  provider?: LlmProvider;
  /** Overrides the provider's base URL (and its `*_BASE_URL` env var). */
  baseUrl?: string;
  /** Overrides the provider's API key env var. */
  apiKey?: string;
}

type OpenAiCompatProvider = Exclude<LlmProvider, "anthropic" | "local-test">;

export function createLlmClient(modelOrOptions: string | CreateLlmClientOptions): LlmClient {
  loadDotEnv();

  const options: CreateLlmClientOptions =
    typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;

  const provider = resolveProvider(options.provider, options.model);
  const timeoutMs = readTimeoutMs();

  if (provider === "local-test") {
    return new LocalTestClient();
  }

  if (provider === "anthropic") {
    const apiKey = options.apiKey ?? getAnthropicApiKey();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required to use the Anthropic provider");
    }
    return new AnthropicClient(options.model, apiKey, {
      baseUrl: options.baseUrl ?? readEnv("ANTHROPIC_BASE_URL"),
      timeoutMs,
    });
  }

  return new OpenAiCompatClient({ ...openAiCompatConfig(provider, options), timeoutMs });
}

/**
 * Picks the provider when none was requested explicitly. A model name that
 * unambiguously belongs to a provider wins, but only if that provider's key is
 * configured; otherwise fall back to key availability (Z.ai first).
 */
export function resolveProvider(provider: LlmProvider | undefined, model: string): LlmProvider {
  if (provider) {
    return provider;
  }

  if (model === "local-test" || model === "test") {
    return "local-test";
  }

  if (model.startsWith("claude") && getAnthropicApiKey()) {
    return "anthropic";
  }

  if (/^(?:gpt-|chatgpt-|o[134](?:-|$))/.test(model) && getOpenAiApiKey()) {
    return "openai";
  }

  // OpenRouter model ids are "<vendor>/<model>", e.g. "qwen/qwen3-coder".
  if (model.includes("/") && getOpenRouterApiKey()) {
    return "openrouter";
  }

  if (getAnthropicApiKey() && !getZaiApiKey()) {
    return "anthropic";
  }

  return "zai";
}

function openAiCompatConfig(
  provider: OpenAiCompatProvider,
  options: CreateLlmClientOptions,
): OpenAiCompatConfig {
  switch (provider) {
    case "zai": {
      const apiKey = options.apiKey ?? getZaiApiKey();
      if (!apiKey) {
        throw new Error(
          `No LLM client configured for model: ${options.model}. Set Z_AI_API_KEY (or ZAI_API_KEY) or use --provider local-test.`,
        );
      }
      return {
        name: "Z.ai",
        baseUrl:
          options.baseUrl ??
          readEnv("Z_AI_BASE_URL") ??
          readEnv("ZAI_BASE_URL") ??
          ZAI_DEFAULT_BASE_URL,
        model: options.model || ZAI_DEFAULT_MODEL,
        apiKey,
        headers: { "Accept-Language": "en-US,en" },
        thinkingToggle: "zai",
        visionModel: readEnv("REVCODE_VISION_MODEL") ?? ZAI_DEFAULT_VISION_MODEL,
      };
    }

    case "openai": {
      const apiKey = options.apiKey ?? getOpenAiApiKey();
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required to use the OpenAI provider");
      }
      const model = requireModel(provider, options.model);
      return {
        name: "OpenAI",
        baseUrl: options.baseUrl ?? readEnv("OPENAI_BASE_URL") ?? OPENAI_DEFAULT_BASE_URL,
        model,
        apiKey,
        maxTokensParam: "max_completion_tokens",
        // Reasoning models only accept the default temperature.
        omitTemperature: /^(?:o\d|gpt-5)/.test(model),
        visionModel: readEnv("REVCODE_VISION_MODEL") ?? (/^(?:gpt-4o|gpt-4\.1|gpt-5|o[134])/.test(model) ? model : undefined),
      };
    }

    case "openrouter": {
      const apiKey = options.apiKey ?? getOpenRouterApiKey();
      if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is required to use the OpenRouter provider");
      }
      return {
        name: "OpenRouter",
        baseUrl: options.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
        model: requireModel(provider, options.model),
        apiKey,
        headers: { "X-Title": "RevCode" },
        visionModel: readEnv("REVCODE_VISION_MODEL"),
      };
    }

    case "ollama":
      return {
        name: "Ollama",
        baseUrl: options.baseUrl ?? ollamaBaseUrl(readEnv("OLLAMA_HOST")),
        model: requireModel(provider, options.model),
        apiKey: options.apiKey,
        visionModel: readEnv("REVCODE_VISION_MODEL"),
      };

    case "openai-compat": {
      const baseUrl = options.baseUrl ?? readEnv("REVCODE_BASE_URL");
      if (!baseUrl) {
        throw new Error(
          "REVCODE_BASE_URL is required to use the openai-compat provider (or pass --base-url)",
        );
      }
      return {
        name: "OpenAI-compatible",
        baseUrl,
        model: requireModel(provider, options.model),
        // Local servers (vLLM, LM Studio, llama.cpp) usually need no key.
        apiKey: options.apiKey ?? readEnv("REVCODE_API_KEY"),
        visionModel: readEnv("REVCODE_VISION_MODEL"),
      };
    }
  }
}

function requireModel(provider: LlmProvider, model: string): string {
  if (!model.trim()) {
    throw new Error(`A model name is required to use the ${provider} provider (pass --model)`);
  }
  return model;
}

/**
 * `OLLAMA_HOST` follows Ollama's own convention: it may omit the scheme and/or
 * the port ("127.0.0.1:11434", "gpu-box"). The OpenAI-compatible API lives
 * under `/v1`.
 */
function ollamaBaseUrl(host: string | undefined): string {
  const raw = host ?? OLLAMA_DEFAULT_HOST;
  const hasScheme = /^https?:\/\//i.test(raw);

  let root = raw.replace(/\/+$/, "");
  if (!hasScheme) {
    try {
      const url = new URL(`http://${root}`);
      if (!url.port) {
        url.port = OLLAMA_DEFAULT_PORT;
      }
      root = url.origin;
    } catch {
      root = `http://${root}`;
    }
  }

  return root.endsWith("/v1") ? root : `${root}/v1`;
}

function readTimeoutMs(): number | undefined {
  const parsed = Number(readEnv("REVCODE_LLM_TIMEOUT_MS"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getZaiApiKey(): string | undefined {
  return readEnv("Z_AI_API_KEY") ?? readEnv("ZAI_API_KEY");
}

function getAnthropicApiKey(): string | undefined {
  return readEnv("ANTHROPIC_API_KEY");
}

function getOpenAiApiKey(): string | undefined {
  return readEnv("OPENAI_API_KEY");
}

function getOpenRouterApiKey(): string | undefined {
  return readEnv("OPENROUTER_API_KEY");
}

function loadDotEnv(): void {
  loadEnvFiles();
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
