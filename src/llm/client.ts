/**
 * LLM API client abstraction.
 *
 * TODO: implement HTTP client for the chosen provider(s).
 *       Should support streaming responses and tool_use content blocks.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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

export function createLlmClient(model: string): LlmClient {
  // TODO: route to the correct provider based on model prefix
  throw new Error(`No LLM client configured for model: ${model}`);
}
