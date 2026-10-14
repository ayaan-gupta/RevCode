import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicClient, anthropicMessagesUrl } from "./anthropic.js";
import type { LlmMessage, LlmStreamDelta, ToolDefinition } from "./client.js";
import { eventFrames, jsonResponse, sseResponse, stubFetch } from "./test-helpers.js";

const MODEL = "claude-sonnet-4-6";

const READ_FILE: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};
const LIST_DIR: ToolDefinition = {
  name: "list_directory",
  description: "List a directory",
  parameters: { type: "object", properties: {} },
};

const USER: LlmMessage[] = [
  { role: "system", content: "You are RevCode." },
  { role: "user", content: "hi" },
];

function toolResult(id: string, name: string, result: unknown): LlmMessage {
  return {
    role: "tool",
    toolCallId: id,
    name,
    content: JSON.stringify({ toolCallId: id, name, result }),
  };
}

function message(content: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content,
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 7 },
    ...extra,
  };
}

function client(options: ConstructorParameters<typeof AnthropicClient>[2] = {}, model = MODEL) {
  return new AnthropicClient(model, "sk-ant-test", options);
}

/** Every `cache_control` marker in a request body, as JSON paths. */
function cacheMarkers(body: Record<string, unknown>): string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "cache_control") {
          found.push(path);
        } else {
          walk(child, `${path}.${key}`);
        }
      }
    }
  };
  walk(body, "$");
  return found;
}

beforeEach(() => {
  vi.stubEnv("REVCODE_NO_CACHE", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("anthropicMessagesUrl", () => {
  it.each([
    [undefined, "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com", "https://api.anthropic.com/v1/messages"],
    ["https://api.anthropic.com/", "https://api.anthropic.com/v1/messages"],
    ["https://proxy.test/v1", "https://proxy.test/v1/messages"],
    ["https://proxy.test/v1/", "https://proxy.test/v1/messages"],
    ["https://proxy.test/anthropic", "https://proxy.test/anthropic/v1/messages"],
    ["https://proxy.test/v1/messages", "https://proxy.test/v1/messages"],
  ])("%s -> %s", (base, expected) => {
    expect(anthropicMessagesUrl(base)).toBe(expected);
  });
});

describe("AnthropicClient request", () => {
  it("sends the required headers to /v1/messages", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([{ type: "text", text: "ok" }])));

    await client().complete(USER);

    expect(requests[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0].headers).toMatchObject({
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
  });

  it("uses a configured base URL", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client({ baseUrl: "https://gateway.test/v1" }).complete(USER);

    expect(requests[0].url).toBe("https://gateway.test/v1/messages");
  });

  it("defaults max_tokens to 16384 and honors overrides", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client().complete(USER);
    await client().complete(USER, [], { maxTokens: 2048 });

    expect(requests[0].body.max_tokens).toBe(16_384);
    expect(requests[1].body.max_tokens).toBe(2048);
  });

  it("sends temperature only when requested and supported by the model", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client().complete(USER);
    await client().complete(USER, [], { temperature: 0.3 });
    // Current Claude models 400 on explicit sampling parameters.
    await client({}, "claude-sonnet-5-5").complete(USER, [], { temperature: 0.3 });
    await client({}, "claude-opus-5-5").complete(USER, [], { temperature: 0.3 });
    await client({}, "claude-haiku-4-5").complete(USER, [], { temperature: 0.3 });

    expect(requests[0].body).not.toHaveProperty("temperature");
    expect(requests[1].body.temperature).toBe(0.3);
    expect(requests[2].body).not.toHaveProperty("temperature");
    expect(requests[3].body).not.toHaveProperty("temperature");
    expect(requests[4].body.temperature).toBe(0.3);
  });

  it("defaults the model to claude-sonnet-5-5", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await new AnthropicClient("", "k").complete(USER);

    expect(requests[0].body.model).toBe("claude-sonnet-5-5");
  });

  it("omits tools when there are none and sets stream flags", async () => {
    const { requests } = stubFetch([
      () => jsonResponse(message([])),
      () => sseResponse(eventFrames({ type: "message_stop" })),
    ]);

    await client().complete(USER);
    await client().complete(USER, [], { onDelta: () => undefined });

    expect(requests[0].body).toMatchObject({ stream: false });
    expect(requests[0].body).not.toHaveProperty("tools");
    expect(requests[1].body).toMatchObject({ stream: true });
    expect(requests[1].headers.accept).toBe("text/event-stream");
  });
});

describe("AnthropicClient message conversion", () => {
  it("merges tool results from parallel calls into ONE user message", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));
    const messages: LlmMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "do both" },
      {
        role: "assistant",
        content: "On it.",
        toolCalls: [
          { id: "t1", name: "read_file", arguments: { path: "a" } },
          { id: "t2", name: "list_directory", arguments: {} },
        ],
      },
      toolResult("t1", "read_file", { path: "a", content: "A" }),
      toolResult("t2", "list_directory", { path: ".", entries: ["x"] }),
    ];

    await client().complete(messages, [READ_FILE, LIST_DIR]);

    const sent = requests[0].body.messages as Array<{ role: string; content: unknown[] }>;
    expect(sent.map((entry) => entry.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[1].content).toEqual([
      { type: "text", text: "On it." },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
      { type: "tool_use", id: "t2", name: "list_directory", input: {} },
    ]);
    expect(sent[2].content).toMatchObject([
      { type: "tool_result", tool_use_id: "t1", content: "a\nA" },
      { type: "tool_result", tool_use_id: "t2", content: ".\nx" },
    ]);
  });

  it("flags tool results that carry a string error as is_error", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client().complete([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "t1", name: "read_file", arguments: {} },
          { id: "t2", name: "read_file", arguments: {} },
          { id: "t3", name: "read_file", arguments: {} },
        ],
      },
      toolResult("t1", "read_file", { error: "File not found" }),
      toolResult("t2", "read_file", { content: "fine", error: 42 }),
      toolResult("t3", "read_file", "plain output"),
    ]);

    const sent = requests[0].body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const results = sent[2].content;
    expect(results[0]).toMatchObject({
      tool_use_id: "t1",
      content: "Error: File not found",
      is_error: true,
    });
    expect(results[1]).toMatchObject({ tool_use_id: "t2", content: "fine" });
    expect(results[1]).not.toHaveProperty("is_error");
    expect(results[2]).toMatchObject({ tool_use_id: "t3", content: "plain output" });
    expect(results[2]).not.toHaveProperty("is_error");
  });

  it("sends multi-line tool results as plain text, not JSON-escaped", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));
    const fileText = 'const a = "x";\n  return a;\n';

    await client().complete([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: {} }] },
      toolResult("t1", "read_file", { path: "src/a.ts", totalLines: 2, content: fileText }),
    ]);

    const sent = requests[0].body.messages as Array<{ content: Array<{ content?: string }> }>;
    const content = sent[2].content[0].content;
    expect(content).toBe(`src/a.ts (2 lines)\n${fileText}`);
    expect(content).not.toContain("\\n");
    expect(content).not.toContain('\\"');
  });

  it("merges consecutive user text and puts tool_result blocks first", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client().complete([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "read_file", arguments: {} }],
      },
      { role: "user", content: "also, please hurry" },
      toolResult("t1", "read_file", { content: "A" }),
      { role: "user", content: "thanks" },
    ]);

    const sent = requests[0].body.messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(sent.map((entry) => entry.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[2].content.map((block) => block.type)).toEqual(["tool_result", "text", "text"]);
  });

  it("derives the tool call id from the envelope when toolCallId is not set", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client().complete([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "t9", name: "read_file", arguments: {} }] },
      { role: "tool", content: JSON.stringify({ toolCallId: "t9", name: "read_file", result: { content: "x" } }) },
    ]);

    const sent = requests[0].body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(sent[2].content[0]).toMatchObject({ tool_use_id: "t9", content: "x" });
  });

  it("drops blank assistant turns and blank text blocks instead of sending empty text", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client({ promptCaching: false }).complete([
      { role: "system", content: "   " },
      { role: "user", content: "a" },
      { role: "assistant", content: "  " },
      { role: "user", content: "b" },
    ]);

    expect(requests[0].body).not.toHaveProperty("system");
    expect(requests[0].body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ]);
  });

  it("hoists every system message into the system prompt in order", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client({ promptCaching: false }).complete([
      { role: "system", content: "first" },
      { role: "user", content: "hi" },
      { role: "system", content: "second" },
    ]);

    expect(requests[0].body.system).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });
});

describe("AnthropicClient prompt caching", () => {
  const conversation: LlmMessage[] = [
    { role: "system", content: "You are RevCode." },
    { role: "user", content: "task" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: {} }] },
    toolResult("t1", "read_file", { content: "A" }),
    { role: "assistant", content: "", toolCalls: [{ id: "t2", name: "read_file", arguments: {} }] },
    toolResult("t2", "read_file", { content: "B" }),
  ];

  it("sends the system prompt as a block array with a cache breakpoint", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client().complete(USER);

    expect(requests[0].body.system).toEqual([
      { type: "text", text: "You are RevCode.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("marks the last tool and the tail of the conversation, within the 4 breakpoint limit", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client().complete(conversation, [READ_FILE, LIST_DIR]);

    const body = requests[0].body;
    expect((body.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty("cache_control");
    expect((body.tools as Array<Record<string, unknown>>)[1]).toHaveProperty("cache_control");

    // messages: [user task, assistant, user results(t1), assistant, user results(t2)]
    expect(cacheMarkers(body).sort()).toEqual(
      [
        "$.system[0]",
        "$.tools[1]",
        "$.messages[2].content[0]", // previous turn's breakpoint: guarantees a cache read
        "$.messages[4].content[0]", // last user/tool-result message, last block
      ].sort(),
    );
  });

  it("puts the breakpoint on the last block of a merged tool-result message", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client().complete(
      [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "t1", name: "read_file", arguments: {} },
            { id: "t2", name: "read_file", arguments: {} },
          ],
        },
        toolResult("t1", "read_file", { content: "A" }),
        toolResult("t2", "read_file", { content: "B" }),
      ],
      [READ_FILE],
    );

    expect(cacheMarkers(requests[0].body)).toContain("$.messages[2].content[1]");
    expect(cacheMarkers(requests[0].body)).not.toContain("$.messages[2].content[0]");
  });

  it("never exceeds four breakpoints", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));
    const long: LlmMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 6; i += 1) {
      long.push({ role: "user", content: `u${i}` });
      long.push({ role: "assistant", content: `a${i}` });
    }
    long.push({ role: "user", content: "final" });

    await client().complete(long, [READ_FILE, LIST_DIR]);

    expect(cacheMarkers(requests[0].body)).toHaveLength(4);
  });

  it("sends no cache_control at all when REVCODE_NO_CACHE=1", async () => {
    vi.stubEnv("REVCODE_NO_CACHE", "1");
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client().complete(conversation, [READ_FILE]);

    expect(cacheMarkers(requests[0].body)).toEqual([]);
    // Still a block array, so toggling the switch never changes the shape.
    expect(requests[0].body.system).toEqual([{ type: "text", text: "You are RevCode." }]);
  });

  it("lets the constructor option override the environment", async () => {
    vi.stubEnv("REVCODE_NO_CACHE", "1");
    const { requests } = stubFetch(() => jsonResponse(message([])));

    await client({ promptCaching: true }).complete(USER);

    expect(cacheMarkers(requests[0].body).sort()).toEqual(
      ["$.messages[0].content[0]", "$.system[0]"].sort(),
    );
  });
});

describe("AnthropicClient non-streaming response", () => {
  it("extracts text, tool calls, usage with cache reads, and finish reason", async () => {
    stubFetch(() =>
      jsonResponse(
        message(
          [
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } },
          ],
          {
            stop_reason: "tool_use",
            usage: {
              input_tokens: 12,
              output_tokens: 40,
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 800,
            },
          },
        ),
      ),
    );

    const response = await client().complete(USER, [READ_FILE]);

    expect(response).toEqual({
      content: "Reading.",
      toolCalls: [{ id: "toolu_1", name: "read_file", arguments: { path: "a.txt" } }],
      usage: { inputTokens: 912, outputTokens: 40, cachedInputTokens: 800 },
      finishReason: "tool_calls",
    });
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "tool_calls"],
    ["refusal", "refusal"],
  ])("maps stop_reason %s to %s", async (stopReason, expected) => {
    stubFetch(() => jsonResponse(message([{ type: "text", text: "x" }], { stop_reason: stopReason })));

    expect((await client().complete(USER)).finishReason).toBe(expected);
  });

  it("surfaces thinking text as reasoning and ignores unknown block types", async () => {
    stubFetch(() =>
      jsonResponse(
        message([
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "redacted_thinking", data: "..." },
          { type: "text", text: "answer" },
        ]),
      ),
    );

    const response = await client().complete(USER);
    expect(response).toMatchObject({ content: "answer", reasoning: "hmm" });
  });

  it("reports HTTP errors with status and body", async () => {
    stubFetch(() => new Response('{"type":"error"}', { status: 400 }));

    await expect(client().complete(USER)).rejects.toThrow(
      'Anthropic API request failed (400): {"type":"error"}',
    );
  });
});

describe("AnthropicClient streaming", () => {
  const start = {
    type: "message_start",
    message: {
      id: "msg_1",
      usage: { input_tokens: 15, cache_read_input_tokens: 300, cache_creation_input_tokens: 5, output_tokens: 1 },
    },
  };

  async function stream(chunks: string[], tools: ToolDefinition[] = [READ_FILE]) {
    stubFetch(() => sseResponse(chunks));
    const deltas: LlmStreamDelta[] = [];
    const response = await client().complete(USER, tools, { onDelta: (d) => deltas.push(d) });
    return { response, deltas };
  }

  it("streams text deltas and maps usage and stop reason", async () => {
    const { response, deltas } = await stream(
      eventFrames(
        start,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "ping" },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
        { type: "message_stop" },
      ),
    );

    expect(deltas).toEqual([{ text: "Hel" }, { text: "lo" }]);
    expect(response).toEqual({
      content: "Hello",
      toolCalls: [],
      usage: { inputTokens: 320, outputTokens: 9, cachedInputTokens: 300 },
      finishReason: "stop",
    });
  });

  it("assembles tool input from fragmented input_json_delta events", async () => {
    const { response } = await stream(
      eventFrames(
        start,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking." } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
        },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pa' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'th": "src/' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'a.ts"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
        { type: "message_stop" },
      ),
    );

    expect(response.content).toBe("Looking.");
    expect(response.toolCalls).toEqual([
      { id: "toolu_1", name: "read_file", arguments: { path: "src/a.ts" } },
    ]);
    expect(response.finishReason).toBe("tool_calls");
  });

  it("keeps parallel tool_use blocks apart by index, even when their fragments interleave", async () => {
    const { response } = await stream(
      eventFrames(
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_a", name: "read_file", input: {} },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_b", name: "list_directory", input: {} },
        },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      ),
      [READ_FILE, LIST_DIR],
    );

    expect(response.toolCalls).toEqual([
      { id: "toolu_a", name: "read_file", arguments: { path: "a" } },
      { id: "toolu_b", name: "list_directory", arguments: {} },
    ]);
  });

  it("gives a tool with no input an empty arguments object", async () => {
    const { response } = await stream(
      eventFrames(start, {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_a", name: "list_directory", input: {} },
      }),
    );

    expect(response.toolCalls).toEqual([{ id: "toolu_a", name: "list_directory", arguments: {} }]);
  });

  it("preserves truncated tool JSON under `input` and reports length", async () => {
    const { response } = await stream(
      eventFrames(
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_a", name: "read_file", input: {} },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a' } },
        { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 3 } },
      ),
    );

    expect(response.toolCalls[0].arguments).toEqual({ input: '{"path":"a' });
    expect(response.finishReason).toBe("length");
  });

  it("surfaces thinking deltas as reasoning", async () => {
    const { response, deltas } = await stream(
      eventFrames(
        start,
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
      ),
    );

    expect(deltas).toEqual([{ reasoning: "pondering" }, { text: "done" }]);
    expect(response).toMatchObject({ content: "done", reasoning: "pondering" });
  });

  it("takes the latest cumulative usage from message_delta", async () => {
    const { response } = await stream(
      eventFrames(
        { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 10, cache_read_input_tokens: 40, output_tokens: 25 },
        },
      ),
    );

    expect(response.usage).toEqual({ inputTokens: 50, outputTokens: 25, cachedInputTokens: 40 });
  });

  it("survives frames split across arbitrary read boundaries", async () => {
    const whole = eventFrames(
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello wörld" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    ).join("");

    const { response } = await stream(whole.match(/[\s\S]{1,9}/g) ?? []);
    expect(response.content).toBe("Hello wörld");
  });

  it("throws on an in-band error event", async () => {
    stubFetch(() =>
      sseResponse(
        eventFrames({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      ),
    );

    await expect(client().complete(USER, [], { onDelta: () => undefined })).rejects.toThrow(
      "Anthropic stream error (overloaded_error): Overloaded",
    );
  });

  it("wraps a failure after text was emitted but not one before", async () => {
    const text = eventFrames(
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    );
    stubFetch([
      () => sseResponse(text, { failWith: new Error("socket closed") }),
      () => sseResponse(eventFrames(start), { failWith: new Error("socket closed") }),
    ]);

    await expect(client().complete(USER, [], { onDelta: () => undefined })).rejects.toThrow(
      "Anthropic stream interrupted after partial output: socket closed",
    );
    await expect(client().complete(USER, [], { onDelta: () => undefined })).rejects.toThrow(
      /^socket closed$/,
    );
  });
});

describe("AnthropicClient abort", () => {
  it("rejects with AbortError for an already-aborted signal without calling fetch", async () => {
    const { requests } = stubFetch(() => jsonResponse(message([])));
    const controller = new AbortController();
    controller.abort();

    await expect(client().complete(USER, [], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(requests).toHaveLength(0);
  });

  it("aborts an open stream and passes the signal to fetch", async () => {
    const { requests } = stubFetch(() =>
      sseResponse(
        eventFrames(
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
        ),
        { hang: true },
      ),
    );
    const controller = new AbortController();

    const pending = client().complete(USER, [], {
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("AnthropicClient.describeImage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the image as a base64 content block to the main model", async () => {
    const { requests } = stubFetch(() =>
      jsonResponse({ content: [{ type: "text", text: "a cat" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } }),
    );
    const client = new AnthropicClient("claude-test", "key");
    const answer = await client.describeImage?.({ mediaType: "image/jpeg", base64: "QUJD", question: "what?" });
    expect(answer).toBe("a cat");
    expect(requests[0].body.model).toBe("claude-test");
    expect(requests[0].body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
          { type: "text", text: "what?" },
        ],
      },
    ]);
  });
});
