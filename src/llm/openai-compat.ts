/**
 * Client for any OpenAI-style `/chat/completions` endpoint: Z.ai, OpenAI,
 * OpenRouter, Ollama, vLLM, LM Studio, llama.cpp, ...
 *
 * Supports non-streaming and SSE streaming (usage is requested via
 * `stream_options.include_usage`), cancellation through `options.signal`, and
 * the Z.ai quirks the agent depends on: `reasoning_content` is surfaced as
 * reasoning, and tool calls the model writes into its text (GLM XML, inline
 * JSON) are recovered by `extractToolCalls`.
 *
 * Streaming failure policy: `fetchWithRetry` retries connection/status
 * failures before the body starts. Once the first text delta has fired, a
 * mid-stream failure is NOT retried (it would duplicate tokens already shown);
 * it surfaces as "<provider> stream interrupted after partial output". A
 * failure before any text is rethrown unchanged so callers may retry. An abort
 * always surfaces as an Error named "AbortError", never wrapped.
 */

import { abortError, isAbortError } from "./abort.js";
import type {
  CompleteOptions,
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmStreamDelta,
  LlmToolCall,
  LlmUsage,
  ToolDefinition,
} from "./client.js";
import {
  type TimeoutConfig,
  requestTimeoutMs,
  resolveMaxTokens,
  streamIdleTimeoutMs,
} from "./defaults.js";
import { fetchWithRetry } from "./retry.js";
import { IMAGE_ANSWER_TOKENS, type ImageQuestion } from "./vision.js";
import { readSse } from "./sse.js";
import { extractToolCalls } from "./tool-call-parser.js";
import { parseToolArguments, parseToolResultMessage } from "./tool-result.js";

const DEFAULT_TEMPERATURE = 0.2;

export interface OpenAiCompatConfig extends TimeoutConfig {
  /** Provider label used in error and warning messages, e.g. "Z.ai". */
  name: string;
  /** API root without `/chat/completions`, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  model: string;
  /** Sent as a Bearer token. Optional: local servers usually need none. */
  apiKey?: string;
  /** Extra request headers (attribution headers, locale, ...). */
  headers?: Record<string, string>;
  /** Temperature when the caller does not specify one. */
  defaultTemperature?: number;
  /** Never send `temperature` (e.g. OpenAI reasoning models reject it). */
  omitTemperature?: boolean;
  /**
   * Name of the completion-limit field. OpenAI's reasoning models reject
   * `max_tokens`; most other servers only understand it.
   */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Provider has a request-level thinking switch (`thinking: {type: "disabled"}`, Z.ai style). */
  thinkingToggle?: "zai";
  /** A vision-capable model on the same endpoint; enables `describeImage` (and so the `view_image` tool). */
  visionModel?: string;
}

export class OpenAiCompatClient implements LlmClient {
  private readonly config: OpenAiCompatConfig;
  private readonly endpoint: string;

  /** Set only when a vision model is configured, so callers can feature-detect it. */
  readonly describeImage?: LlmClient["describeImage"];

  constructor(config: OpenAiCompatConfig) {
    this.config = config;
    this.endpoint = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
    if (config.visionModel) {
      this.describeImage = (image, options) => this.askVisionModel(config.visionModel as string, image, options?.signal);
    }
  }

  private async askVisionModel(model: string, image: ImageQuestion, signal?: AbortSignal): Promise<string> {
    const response = await fetchWithRetry(
      this.endpoint,
      {
        method: "POST",
        headers: this.headers(false),
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: image.question },
                { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
              ],
            },
          ],
          temperature: 0.1,
          [this.config.maxTokensParam ?? "max_tokens"]: IMAGE_ANSWER_TOKENS,
          stream: false,
        }),
        signal,
      },
      { timeoutMs: requestTimeoutMs(this.config) },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${this.config.name} vision request (${model}) failed (${response.status}): ${text.slice(0, 500)}`);
    }
    let payload: OpenAiChatCompletionResponse;
    try {
      payload = JSON.parse(text) as OpenAiChatCompletionResponse;
    } catch {
      throw new Error(`${this.config.name} vision request returned a non-JSON response: ${text.slice(0, 200)}`);
    }
    const answer = payload.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      throw new Error(`${this.config.name} vision model ${model} returned no answer`);
    }
    return answer;
  }

  async complete(
    messages: LlmMessage[],
    tools: ToolDefinition[] = [],
    options: CompleteOptions = {},
  ): Promise<LlmResponse> {
    try {
      return options.onDelta
        ? await this.completeStreaming(messages, tools, options, options.onDelta)
        : await this.completeOnce(messages, tools, options);
    } catch (error) {
      // fetch rejects with the signal's own reason, which is only an
      // AbortError when the caller aborted without one.
      if (options.signal?.aborted && !isAbortError(error)) {
        throw abortError(options.signal);
      }
      throw error;
    }
  }

  private async completeOnce(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    options: CompleteOptions,
  ): Promise<LlmResponse> {
    const response = await fetchWithRetry(
      this.endpoint,
      {
        method: "POST",
        headers: this.headers(false),
        body: this.requestBody(messages, tools, options, false),
        signal: options.signal,
      },
      { timeoutMs: requestTimeoutMs(this.config) },
    );

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`${this.config.name} API request failed (${response.status}): ${responseText}`);
    }

    let payload: OpenAiChatCompletionResponse;
    try {
      payload = JSON.parse(responseText) as OpenAiChatCompletionResponse;
    } catch {
      throw new Error(
        `${this.config.name} API returned a non-JSON response: ${responseText.slice(0, 200)}`,
      );
    }

    const choice = payload.choices?.[0];
    const message = choice?.message;
    if (!message) {
      const detail = payload.error ? `: ${describeError(payload.error)}` : "";
      throw new Error(`${this.config.name} API response did not include a message${detail}`);
    }

    const apiToolCalls = (message.tool_calls ?? []).map(fromOpenAiToolCall);
    const content = message.content ?? "";
    const extracted = extractToolCalls({ toolCalls: apiToolCalls, content, tools });

    if (extracted.usedFallback) {
      console.warn(
        "[revcode] Parsed tool calls from assistant content fallback (XML/inline JSON).",
      );
    }

    return buildResponse({
      content: extracted.content,
      toolCalls: extracted.toolCalls,
      reasoning: message.reasoning_content || message.reasoning || undefined,
      usage: fromOpenAiUsage(payload.usage),
      finishReason: choice.finish_reason ?? undefined,
    });
  }

  private async completeStreaming(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    options: CompleteOptions,
    onDelta: (delta: LlmStreamDelta) => void,
  ): Promise<LlmResponse> {
    const response = await fetchWithRetry(
      this.endpoint,
      {
        method: "POST",
        headers: this.headers(true),
        body: this.requestBody(messages, tools, options, true),
        signal: options.signal,
      },
      { timeoutMs: requestTimeoutMs(this.config) },
    );

    if (!response.ok || !response.body) {
      const errorText = response.body ? await response.text() : "";
      throw new Error(`${this.config.name} API request failed (${response.status}): ${errorText}`);
    }

    let content = "";
    let reasoning = "";
    let deltaEmitted = false;
    let usage: LlmUsage | undefined;
    let finishReason: string | undefined;
    const toolAcc = new ToolCallAccumulator();

    try {
      const events = readSse(response.body, {
        signal: options.signal,
        idleTimeoutMs: streamIdleTimeoutMs(this.config),
      });

      for await (const event of events) {
        const chunk = parseChunk(event.data);
        if (!chunk) {
          continue; // keep-alives / partial frames
        }
        if (chunk.error) {
          throw new Error(`${this.config.name} stream error: ${describeError(chunk.error)}`);
        }

        // Usage arrives in a trailing chunk whose `choices` is empty.
        usage = fromOpenAiUsage(chunk.usage) ?? usage;

        const choice = chunk.choices?.[0];
        if (!choice) {
          continue;
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta;
        if (!delta) {
          continue;
        }
        const reasoningDelta = delta.reasoning_content || delta.reasoning;
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          onDelta({ reasoning: reasoningDelta });
        }
        if (delta.content) {
          content += delta.content;
          deltaEmitted = true;
          onDelta({ text: delta.content });
        }
        for (const fragment of delta.tool_calls ?? []) {
          toolAcc.add(fragment);
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw abortError(options.signal);
      }
      if (deltaEmitted) {
        throw new Error(
          `${this.config.name} stream interrupted after partial output: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }

    const extracted = extractToolCalls({ toolCalls: toolAcc.finish(), content, tools });
    return buildResponse({
      content: extracted.content,
      toolCalls: extracted.toolCalls,
      reasoning: reasoning || undefined,
      usage,
      finishReason,
    });
  }

  private headers(stream: boolean): Record<string, string> {
    return {
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      "Content-Type": "application/json",
      ...(stream ? { Accept: "text/event-stream" } : {}),
      ...this.config.headers,
    };
  }

  private requestBody(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    options: CompleteOptions,
    stream: boolean,
  ): string {
    const temperature = this.config.omitTemperature
      ? undefined
      : (options.temperature ?? this.config.defaultTemperature ?? DEFAULT_TEMPERATURE);

    return JSON.stringify({
      model: this.config.model,
      messages: messages.map(toOpenAiMessage),
      // Strict servers (OpenAI) reject an empty `tools` array and a
      // `tool_choice` with no tools.
      ...(tools.length > 0 ? { tools: tools.map(toOpenAiTool), tool_choice: "auto" } : {}),
      temperature,
      [this.config.maxTokensParam ?? "max_tokens"]: resolveMaxTokens(options.maxTokens),
      ...(options.thinking === "off" && this.config.thinkingToggle === "zai"
        ? { thinking: { type: "disabled" } }
        : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    });
  }
}

interface FragmentedToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Reassembles streamed tool calls. Servers disagree on the details, so this
 * keys on whatever identifies a call: the standard shape is an `index` with
 * `id`/`name` only in the first fragment; others resend `id`/`name` in every
 * fragment, omit `index`, or (older Ollama) reuse index 0 for every call and
 * rely on a fresh `id`.
 */
class ToolCallAccumulator {
  private readonly calls: FragmentedToolCall[] = [];
  private readonly byIndex = new Map<number, FragmentedToolCall>();
  private latest: FragmentedToolCall | undefined;

  add(fragment: OpenAiToolCallFragment): void {
    const name = fragment.function?.name;
    const args = fragment.function?.arguments;
    const call = this.resolve(fragment.index, fragment.id, name);

    if (fragment.id && !call.id) {
      call.id = fragment.id;
    }
    if (name) {
      if (!call.name) {
        call.name = name;
      } else if (name !== call.name) {
        call.name += name; // name split across fragments
      }
    }
    if (args) {
      call.args += args;
    }
    this.latest = call;
  }

  finish(): LlmToolCall[] {
    return this.calls
      .filter((call) => call.name !== "" || call.args !== "")
      .map((call) => ({
        id: call.id || nextToolCallId(),
        name: call.name,
        arguments: parseToolArguments(call.args),
      }));
  }

  private resolve(
    index: number | undefined,
    id: string | undefined,
    name: string | undefined,
  ): FragmentedToolCall {
    if (index !== undefined) {
      const existing = this.byIndex.get(index);
      if (existing && !(id && existing.id && existing.id !== id)) {
        return existing;
      }
      return this.create(index);
    }

    if (id) {
      return this.calls.find((call) => call.id === id) ?? this.create();
    }

    const latest = this.latest;
    if (!latest || (name && startsNewCall(latest, name))) {
      return this.create();
    }
    return latest;
  }

  private create(index?: number): FragmentedToolCall {
    const call: FragmentedToolCall = { id: "", name: "", args: "" };
    this.calls.push(call);
    if (index !== undefined) {
      this.byIndex.set(index, call);
    }
    return call;
  }
}

/**
 * For fragments with neither `index` nor `id`: a name that differs from the
 * current call's, or repeats after its arguments are already complete JSON,
 * can only be the start of another call.
 */
function startsNewCall(latest: FragmentedToolCall, name: string): boolean {
  if (latest.name === "") {
    return false;
  }
  return name !== latest.name || isCompleteJson(latest.args);
}

function isCompleteJson(text: string): boolean {
  if (text === "") {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

let toolCallIdCounter = 0;

function nextToolCallId(): string {
  toolCallIdCounter += 1;
  return `call_${Date.now().toString(36)}_${toolCallIdCounter}`;
}

function buildResponse(parts: {
  content: string;
  toolCalls: LlmToolCall[];
  reasoning?: string;
  usage?: LlmUsage;
  finishReason?: string;
}): LlmResponse {
  const response: LlmResponse = { content: parts.content, toolCalls: parts.toolCalls };
  if (parts.reasoning) {
    response.reasoning = parts.reasoning;
  }
  if (parts.usage) {
    response.usage = parts.usage;
  }
  const finishReason = normalizeFinishReason(parts.finishReason, parts.toolCalls.length > 0);
  if (finishReason) {
    response.finishReason = finishReason;
  }
  return response;
}

/**
 * Several servers (Ollama, some vLLM templates) report "stop" even when the
 * turn ended in tool calls, and calls recovered from text have no finish
 * reason of their own; callers branch on "tool_calls", so make it consistent.
 */
function normalizeFinishReason(raw: string | undefined, hasToolCalls: boolean): string | undefined {
  if (raw === "function_call") {
    return "tool_calls";
  }
  if (hasToolCalls && (raw === undefined || raw === "stop")) {
    return "tool_calls";
  }
  return raw;
}

function fromOpenAiUsage(usage: OpenAiUsage | null | undefined): LlmUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (typeof input !== "number" && typeof output !== "number") {
    return undefined;
  }

  const result: LlmUsage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  if (typeof cached === "number") {
    result.cachedInputTokens = cached;
  }
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) {
    result.costUsd = usage.cost;
  }
  return result;
}

function parseChunk(data: string): OpenAiStreamChunk | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as OpenAiStreamChunk) : undefined;
  } catch {
    return undefined;
  }
}

function describeError(error: NonNullable<OpenAiStreamChunk["error"]>): string {
  if (typeof error === "string") {
    return error;
  }
  const code = error.code ?? error.type;
  const message = error.message ?? JSON.stringify(error);
  return code === undefined ? message : `${message} (${code})`;
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

/** What servers may return; some send `arguments` as an object or omit `id`. */
interface ReceivedToolCall {
  id?: string;
  function: {
    name: string;
    arguments?: string | Record<string, unknown> | null;
  };
}

interface OpenAiToolCallFragment {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek-style cache accounting. */
  prompt_cache_hit_tokens?: number;
  /** OpenRouter: what the call cost, in US dollars (credits). */
  cost?: number;
}

type OpenAiErrorBody =
  | string
  | { message?: string; type?: string; code?: string | number | null };

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      /** OpenRouter / Ollama spelling of `reasoning_content`. */
      reasoning?: string | null;
      tool_calls?: ReceivedToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage | null;
  error?: OpenAiErrorBody;
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: OpenAiToolCallFragment[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage | null;
  error?: OpenAiErrorBody;
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

function fromOpenAiToolCall(toolCall: ReceivedToolCall): LlmToolCall {
  const raw = toolCall.function.arguments;
  return {
    id: toolCall.id || nextToolCallId(),
    name: toolCall.function.name,
    arguments: parseToolArguments(typeof raw === "string" ? raw : JSON.stringify(raw ?? {})),
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}
