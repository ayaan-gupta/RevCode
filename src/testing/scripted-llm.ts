/**
 * Scripted LLM for tests and Dyno self-tests: replays a queue of canned
 * responses (or computes them from the conversation) with no network.
 */

import type {
  CompleteOptions,
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  ToolDefinition,
} from "../llm/client.js";

export type ScriptStep =
  | LlmResponse
  | ((messages: LlmMessage[], tools: ToolDefinition[]) => LlmResponse | Promise<LlmResponse>);

export class ScriptedLlm implements LlmClient {
  readonly calls: Array<{ messages: LlmMessage[]; tools: ToolDefinition[]; options?: CompleteOptions }> = [];
  private index = 0;

  constructor(private readonly steps: ScriptStep[]) {}

  async complete(
    messages: LlmMessage[],
    tools: ToolDefinition[] = [],
    options?: CompleteOptions,
  ): Promise<LlmResponse> {
    this.calls.push({ messages: messages.map((m) => ({ ...m })), tools, options });
    const step = this.steps[Math.min(this.index, this.steps.length - 1)];
    this.index += 1;
    if (!step) {
      return { content: "(script exhausted)", toolCalls: [] };
    }
    const response = typeof step === "function" ? await step(messages, tools) : step;
    if (options?.onDelta && response.content) {
      options.onDelta({ text: response.content });
    }
    return response;
  }
}

let callCounter = 0;

/** Build a tool-call response. */
export function toolCall(name: string, args: Record<string, unknown>, content = ""): LlmResponse {
  callCounter += 1;
  const call: LlmToolCall = { id: `call-${callCounter}`, name, arguments: args };
  return { content, toolCalls: [call] };
}

/** Build a final text response. */
export function say(content: string): LlmResponse {
  return { content, toolCalls: [] };
}
