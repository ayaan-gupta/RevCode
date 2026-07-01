/**
 * Anthropic Messages API client.
 */

import type {
  CompleteOptions,
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  ToolDefinition,
} from "./client.js";
import { fetchWithRetry } from "./retry.js";

const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-20250514";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export class AnthropicClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(model: string, apiKey: string) {
    this.apiKey = apiKey;
    this.model = model || ANTHROPIC_DEFAULT_MODEL;
  }

  async complete(
    messages: LlmMessage[],
    tools: ToolDefinition[] = [],
    _options: CompleteOptions = {},
  ): Promise<LlmResponse> {
    const system = messages.find((message) => message.role === "system")?.content;
    const apiMessages = messages
      .filter((message) => message.role !== "system")
      .map(toAnthropicMessage);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 8096,
      messages: apiMessages,
    };

    if (system) {
      body.system = system;
    }

    if (tools.length > 0) {
      body.tools = tools.map(toAnthropicTool);
    }

    const response = await fetchWithRetry(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Anthropic API request failed (${response.status}): ${responseText}`);
    }

    const payload = JSON.parse(responseText) as AnthropicMessageResponse;
    return fromAnthropicResponse(payload);
  }
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function toAnthropicMessage(message: LlmMessage): AnthropicMessage {
  if (message.role === "assistant") {
    const content: AnthropicContentBlock[] = [];
    if (message.content) {
      content.push({ type: "text", text: message.content });
    }

    for (const toolCall of message.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.arguments,
      });
    }

    return {
      role: "assistant",
      content: content.length > 0 ? content : "",
    };
  }

  if (message.role === "tool") {
    const parsed = parseToolResultMessage(message);
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: parsed.toolCallId,
          content: parsed.content,
        },
      ],
    };
  }

  return {
    role: "user",
    content: message.content,
  };
}

function fromAnthropicResponse(payload: AnthropicMessageResponse): LlmResponse {
  const blocks = payload.content ?? [];
  const textParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input ?? {},
      });
    }
  }

  return {
    content: textParts.join("\n"),
    toolCalls,
  };
}

function parseToolResultMessage(message: LlmMessage): { content: string; toolCallId: string } {
  if (message.toolCallId) {
    return {
      content: message.content,
      toolCallId: message.toolCallId,
    };
  }

  try {
    const parsed = JSON.parse(message.content) as {
      toolCallId?: string;
      result?: unknown;
    };
    return {
      content: JSON.stringify(parsed.result ?? parsed),
      toolCallId: parsed.toolCallId ?? "unknown-tool-call",
    };
  } catch {
    return {
      content: message.content,
      toolCallId: "unknown-tool-call",
    };
  }
}
