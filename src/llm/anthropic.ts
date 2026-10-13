/**
 * Anthropic Messages API client (raw `fetch`, no SDK).
 *
 * - Streaming (SSE) and non-streaming completions, cancellable via
 *   `options.signal`. Mid-stream failure policy matches the OpenAI-compatible
 *   client: after the first text delta a failure is not retried and surfaces as
 *   "Anthropic stream interrupted after partial output"; an abort always
 *   surfaces as an Error named "AbortError".
 * - Prompt caching: `cache_control` breakpoints go on the system prompt, the
 *   last tool definition and the tail of the conversation, so each agent turn
 *   reads the previous turn's prefix from cache. `REVCODE_NO_CACHE=1` turns it
 *   off (e.g. for providers behind a proxy that rejects the field).
 * - History is normalised to what the API requires: consecutive user-role
 *   content (tool results from parallel tool calls, follow-up text) is merged
 *   into one message, with `tool_result` blocks first.
 * - Extended thinking is not requested. Thinking text a model emits anyway is
 *   surfaced as `reasoning`; thinking blocks are not replayed in later turns.
 *
 * Usage convention (shared with the OpenAI-compatible client): `inputTokens`
 * is the whole prompt, including cache reads and writes, and
 * `cachedInputTokens` is the portion served from cache. Anthropic's own
 * `input_tokens` field excludes both.
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
import { readSse } from "./sse.js";
import { parseToolArguments, parseToolResultMessage } from "./tool-result.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5-5";
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Models that reject `temperature`/`top_p`/`top_k` with a 400 (sampling is
 * fixed server-side). Sending the harness's temperature to them would fail
 * every request, so it is dropped instead.
 */
const SAMPLING_PARAMS_REJECTED = /^claude-(?:fable|mythos|opus-5|opus-4-[789]|sonnet-5|haiku-5)/;

export interface AnthropicClientOptions extends TimeoutConfig {
  /** API root; `/v1/messages` is appended unless already present. */
  baseUrl?: string;
  /** Force prompt caching on/off; defaults to on unless `REVCODE_NO_CACHE` is set. */
  promptCaching?: boolean;
}

export class AnthropicClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly options: AnthropicClientOptions;

  constructor(model: string, apiKey: string, options: AnthropicClientOptions = {}) {
    this.apiKey = apiKey;
    this.model = model || ANTHROPIC_DEFAULT_MODEL;
    this.endpoint = anthropicMessagesUrl(options.baseUrl);
    this.options = options;
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
      { timeoutMs: requestTimeoutMs(this.options) },
    );

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Anthropic API request failed (${response.status}): ${responseText}`);
    }

    let payload: AnthropicMessageResponse;
    try {
      payload = JSON.parse(responseText) as AnthropicMessageResponse;
    } catch {
      throw new Error(`Anthropic API returned a non-JSON response: ${responseText.slice(0, 200)}`);
    }
    return fromAnthropicResponse(payload);
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
      { timeoutMs: requestTimeoutMs(this.options) },
    );

    if (!response.ok || !response.body) {
      const errorText = response.body ? await response.text() : "";
      throw new Error(`Anthropic API request failed (${response.status}): ${errorText}`);
    }

    const stream = new StreamAssembler(onDelta);
    try {
      const events = readSse(response.body, {
        signal: options.signal,
        idleTimeoutMs: streamIdleTimeoutMs(this.options),
      });
      for await (const event of events) {
        stream.handle(event.data);
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw abortError(options.signal);
      }
      if (stream.textEmitted) {
        throw new Error(
          `Anthropic stream interrupted after partial output: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }

    return stream.finish();
  }

  private headers(stream: boolean): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      ...(stream ? { accept: "text/event-stream" } : {}),
    };
  }

  private requestBody(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    options: CompleteOptions,
    stream: boolean,
  ): string {
    const caching = this.options.promptCaching ?? !isTruthyEnv(process.env.REVCODE_NO_CACHE);
    const system = toSystemBlocks(messages);
    const apiMessages = toAnthropicMessages(messages);
    const apiTools = tools.map(toAnthropicTool);

    if (caching) {
      applyCacheBreakpoints(system, apiTools, apiMessages);
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: resolveMaxTokens(options.maxTokens),
      stream,
      messages: apiMessages,
    };
    if (system.length > 0) {
      body.system = system;
    }
    if (apiTools.length > 0) {
      body.tools = apiTools;
    }
    if (options.temperature !== undefined && !SAMPLING_PARAMS_REJECTED.test(this.model)) {
      body.temperature = options.temperature;
    }
    return JSON.stringify(body);
  }
}

/**
 * Normalises a base URL that may or may not already include `/v1` (or the full
 * `/v1/messages` path) to the Messages endpoint.
 */
export function anthropicMessagesUrl(baseUrl: string = ANTHROPIC_DEFAULT_BASE_URL): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1/messages")) {
    return base;
  }
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

interface CacheControl {
  type: "ephemeral";
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: CacheControl;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: true;
  cache_control?: CacheControl;
}

type AnthropicRequestBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: AnthropicRequestBlock[];
}

interface AnthropicRequestTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}

/** Union of the fields of the block types we read; others are ignored. */
interface AnthropicResponseBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface AnthropicMessageResponse {
  content?: AnthropicResponseBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

function toSystemBlocks(messages: LlmMessage[]): AnthropicTextBlock[] {
  // Anthropic has no system role inside `messages`, so every system message is
  // hoisted into the system prompt in order.
  return messages
    .filter((message) => message.role === "system" && message.content.trim() !== "")
    .map((message) => ({ type: "text", text: message.content }));
}

function toAnthropicTool(tool: ToolDefinition): AnthropicRequestTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function toAnthropicMessages(messages: LlmMessage[]): AnthropicRequestMessage[] {
  const result: AnthropicRequestMessage[] = [];

  // The API requires strictly alternating roles for tool use: parallel tool
  // results must share ONE user message, so same-role neighbours are merged.
  const append = (role: "user" | "assistant", blocks: AnthropicRequestBlock[]): void => {
    if (blocks.length === 0) {
      return;
    }
    const last = result.at(-1);
    if (last?.role === role) {
      last.content.push(...blocks);
    } else {
      result.push({ role, content: [...blocks] });
    }
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      append("assistant", toAssistantBlocks(message));
    } else if (message.role === "tool") {
      append("user", [toToolResultBlock(message)]);
    } else if (message.role === "user" && message.content.trim() !== "") {
      append("user", [{ type: "text", text: message.content }]);
    }
  }

  for (const message of result) {
    if (message.role === "user") {
      // tool_result blocks must precede any text in the same message.
      message.content = [
        ...message.content.filter((block) => block.type === "tool_result"),
        ...message.content.filter((block) => block.type !== "tool_result"),
      ];
    }
  }
  return result;
}

function toAssistantBlocks(message: LlmMessage): AnthropicRequestBlock[] {
  const blocks: AnthropicRequestBlock[] = [];
  // The API rejects empty text blocks, which an assistant turn consisting only
  // of tool calls would otherwise produce.
  if (message.content.trim() !== "") {
    blocks.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.toolCalls ?? []) {
    blocks.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.arguments,
    });
  }
  return blocks;
}

function toToolResultBlock(message: LlmMessage): AnthropicToolResultBlock {
  const parsed = parseToolResultMessage(message);
  const block: AnthropicToolResultBlock = {
    type: "tool_result",
    tool_use_id: parsed.toolCallId,
    content: parsed.content === "" ? "(empty result)" : parsed.content,
  };
  if (parsed.isError) {
    block.is_error = true;
  }
  return block;
}

/**
 * Up to four breakpoints (the API maximum): system prompt, last tool, and the
 * last block of the final two user-role messages. The second-to-last user
 * message is where the previous agent turn placed its breakpoint, so marking it
 * guarantees that turn's cache entry is read even when the new turn appended
 * more blocks than the API's 20-block lookback (many parallel tool results).
 */
function applyCacheBreakpoints(
  system: AnthropicTextBlock[],
  tools: AnthropicRequestTool[],
  messages: AnthropicRequestMessage[],
): void {
  const ephemeral: CacheControl = { type: "ephemeral" };

  const lastSystem = system.at(-1);
  if (lastSystem) {
    lastSystem.cache_control = ephemeral;
  }

  const lastTool = tools.at(-1);
  if (lastTool) {
    lastTool.cache_control = ephemeral;
  }

  const userMessages = messages.filter((message) => message.role === "user");
  for (const message of userMessages.slice(-2)) {
    const lastBlock = message.content.at(-1);
    if (lastBlock) {
      lastBlock.cache_control = ephemeral;
    }
  }
}

function fromAnthropicResponse(payload: AnthropicMessageResponse): LlmResponse {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];

  for (const block of payload.content ?? []) {
    if (block.type === "text" && block.text !== undefined) {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: block.input ?? {} });
    } else if (block.type === "thinking" && block.thinking) {
      reasoningParts.push(block.thinking);
    }
  }

  return buildResponse({
    content: textParts.join("\n"),
    toolCalls,
    reasoning: reasoningParts.join("\n"),
    usage: new UsageTracker().merge(payload.usage).toUsage(),
    stopReason: payload.stop_reason ?? undefined,
  });
}

function buildResponse(parts: {
  content: string;
  toolCalls: LlmToolCall[];
  reasoning: string;
  usage?: LlmUsage;
  stopReason?: string;
}): LlmResponse {
  const response: LlmResponse = { content: parts.content, toolCalls: parts.toolCalls };
  if (parts.reasoning) {
    response.reasoning = parts.reasoning;
  }
  if (parts.usage) {
    response.usage = parts.usage;
  }
  const finishReason = mapStopReason(parts.stopReason);
  if (finishReason) {
    response.finishReason = finishReason;
  }
  return response;
}

function mapStopReason(stopReason: string | undefined): string | undefined {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return stopReason; // pause_turn, refusal, ...: nothing to normalise to
  }
}

/** Anthropic reports usage in pieces across `message_start` and `message_delta`. */
class UsageTracker {
  private input: number | undefined;
  private output: number | undefined;
  private cacheRead: number | undefined;
  private cacheWrite: number | undefined;

  merge(usage: AnthropicUsage | undefined): this {
    if (!usage) {
      return this;
    }
    // Later events carry cumulative totals, so the latest value wins.
    this.input = usage.input_tokens ?? this.input;
    this.output = usage.output_tokens ?? this.output;
    this.cacheRead = usage.cache_read_input_tokens ?? this.cacheRead;
    this.cacheWrite = usage.cache_creation_input_tokens ?? this.cacheWrite;
    return this;
  }

  toUsage(): LlmUsage | undefined {
    if (this.input === undefined && this.output === undefined) {
      return undefined;
    }
    const usage: LlmUsage = {
      inputTokens: (this.input ?? 0) + (this.cacheRead ?? 0) + (this.cacheWrite ?? 0),
      outputTokens: this.output ?? 0,
    };
    if (this.cacheRead !== undefined) {
      usage.cachedInputTokens = this.cacheRead;
    }
    return usage;
  }
}

interface StreamBlock {
  type: string;
  text: string;
  /** Raw JSON accumulated from `input_json_delta` fragments (tool_use). */
  json: string;
  id?: string;
  name?: string;
  initialInput?: Record<string, unknown>;
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    text?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

/**
 * Folds the SSE event stream into a response. Blocks are keyed by `index`
 * because text and tool_use blocks can interleave, and tool input only becomes
 * valid JSON once every `input_json_delta` fragment has arrived.
 */
class StreamAssembler {
  /** True once a text delta has been handed to the caller. */
  textEmitted = false;

  private readonly blocks = new Map<number, StreamBlock>();
  private readonly usage = new UsageTracker();
  private stopReason: string | undefined;

  constructor(private readonly onDelta: (delta: LlmStreamDelta) => void) {}

  handle(data: string): void {
    let event: AnthropicStreamEvent;
    try {
      event = JSON.parse(data) as AnthropicStreamEvent;
    } catch {
      return; // keep-alives / partial frames
    }
    if (typeof event !== "object" || event === null) {
      return;
    }

    switch (event.type) {
      case "message_start":
        this.usage.merge(event.message?.usage);
        break;
      case "content_block_start":
        this.startBlock(event);
        break;
      case "content_block_delta":
        this.applyDelta(event);
        break;
      case "message_delta":
        this.stopReason = event.delta?.stop_reason ?? this.stopReason;
        this.usage.merge(event.usage);
        break;
      case "error": {
        const type = event.error?.type;
        const message = event.error?.message ?? "unknown error";
        throw new Error(`Anthropic stream error${type ? ` (${type})` : ""}: ${message}`);
      }
      default:
        break; // ping, content_block_stop, message_stop
    }
  }

  finish(): LlmResponse {
    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);

    const toolCalls: LlmToolCall[] = ordered
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id ?? "",
        name: block.name ?? "",
        arguments:
          block.json === "" && block.initialInput
            ? block.initialInput
            : parseToolArguments(block.json),
      }));

    return buildResponse({
      content: ordered
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      toolCalls,
      reasoning: ordered
        .filter((block) => block.type === "thinking")
        .map((block) => block.text)
        .join("\n"),
      usage: this.usage.toUsage(),
      stopReason: this.stopReason,
    });
  }

  private startBlock(event: AnthropicStreamEvent): void {
    const start = event.content_block;
    if (event.index === undefined || !start) {
      return;
    }
    const block: StreamBlock = {
      type: start.type ?? "unknown",
      text: "",
      json: "",
      id: start.id,
      name: start.name,
      initialInput: start.input && Object.keys(start.input).length > 0 ? start.input : undefined,
    };
    this.blocks.set(event.index, block);
    if (block.type === "text" && start.text) {
      this.appendText(block, start.text);
    }
  }

  private applyDelta(event: AnthropicStreamEvent): void {
    const delta = event.delta;
    if (event.index === undefined || !delta) {
      return;
    }
    const block = this.blocks.get(event.index) ?? this.createBlock(event.index, delta.type);

    if (delta.type === "text_delta" && delta.text) {
      this.appendText(block, delta.text);
    } else if (delta.type === "input_json_delta" && delta.partial_json) {
      block.json += delta.partial_json;
    } else if (delta.type === "thinking_delta" && delta.thinking) {
      block.text += delta.thinking;
      this.onDelta({ reasoning: delta.thinking });
    }
  }

  /** A delta for a block whose `content_block_start` was never seen. */
  private createBlock(index: number, deltaType: string | undefined): StreamBlock {
    const type =
      deltaType === "input_json_delta"
        ? "tool_use"
        : deltaType === "thinking_delta"
          ? "thinking"
          : "text";
    const block: StreamBlock = { type, text: "", json: "" };
    this.blocks.set(index, block);
    return block;
  }

  private appendText(block: StreamBlock, text: string): void {
    block.text += text;
    this.textEmitted = true;
    this.onDelta({ text });
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
