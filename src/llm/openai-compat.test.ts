import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmMessage, LlmStreamDelta, ToolDefinition } from "./client.js";
import { OpenAiCompatClient, type OpenAiCompatConfig } from "./openai-compat.js";
import { dataFrames, jsonResponse, sseResponse, stubFetch } from "./test-helpers.js";

const BASE: OpenAiCompatConfig = {
  name: "TestAI",
  baseUrl: "https://llm.test/v1/",
  model: "test-model",
  apiKey: "sk-test",
};

const READ_FILE: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

const USER: LlmMessage[] = [{ role: "user", content: "hi" }];

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function toolFragment(
  fragment: Record<string, unknown>,
  finishReason: string | null = null,
): unknown {
  return chunk({ tool_calls: [fragment] }, finishReason);
}

async function stream(
  frames: string[],
  config: Partial<OpenAiCompatConfig> = {},
  tools: ToolDefinition[] = [READ_FILE],
) {
  stubFetch(() => sseResponse(frames));
  const deltas: LlmStreamDelta[] = [];
  const response = await new OpenAiCompatClient({ ...BASE, ...config }).complete(USER, tools, {
    onDelta: (delta) => deltas.push(delta),
  });
  return { response, deltas };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAiCompatClient request", () => {
  it("sends the Z.ai thinking switch only when thinking is off and the provider supports it", async () => {
    const reply = () => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    const { requests } = stubFetch(reply);

    await new OpenAiCompatClient({ ...BASE, thinkingToggle: "zai" }).complete(USER, [], { thinking: "off" });
    await new OpenAiCompatClient({ ...BASE, thinkingToggle: "zai" }).complete(USER, [], { thinking: "on" });
    await new OpenAiCompatClient(BASE).complete(USER, [], { thinking: "off" });

    expect(requests[0].body).toMatchObject({ thinking: { type: "disabled" } });
    expect(requests[1].body).not.toHaveProperty("thinking");
    expect(requests[2].body).not.toHaveProperty("thinking");
  });

  it("posts to <baseUrl>/chat/completions with auth, defaults and tools", async () => {
    const { requests } = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );

    await new OpenAiCompatClient(BASE).complete(USER, [READ_FILE]);

    const [request] = requests;
    expect(request.url).toBe("https://llm.test/v1/chat/completions");
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe("Bearer sk-test");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.body).toMatchObject({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 16_384,
      stream: false,
    });
    expect(request.body.stream_options).toBeUndefined();
    expect(request.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: READ_FILE.parameters,
        },
      },
    ]);
  });

  it("honors temperature and maxTokens overrides", async () => {
    const { requests } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await new OpenAiCompatClient(BASE).complete(USER, [], { temperature: 0, maxTokens: 512 });

    expect(requests[0].body).toMatchObject({ temperature: 0, max_tokens: 512 });
  });

  it("omits tools and tool_choice when there are no tools", async () => {
    const { requests } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await new OpenAiCompatClient(BASE).complete(USER);

    expect(requests[0].body).not.toHaveProperty("tools");
    expect(requests[0].body).not.toHaveProperty("tool_choice");
  });

  it("supports max_completion_tokens and omitting temperature (OpenAI reasoning models)", async () => {
    const { requests } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await new OpenAiCompatClient({
      ...BASE,
      maxTokensParam: "max_completion_tokens",
      omitTemperature: true,
    }).complete(USER, [], { temperature: 0.7, maxTokens: 100 });

    expect(requests[0].body).toMatchObject({ max_completion_tokens: 100 });
    expect(requests[0].body).not.toHaveProperty("max_tokens");
    expect(requests[0].body).not.toHaveProperty("temperature");
  });

  it("omits Authorization when no key is configured and adds extra headers", async () => {
    const { requests } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await new OpenAiCompatClient({
      ...BASE,
      apiKey: undefined,
      headers: { "X-Title": "RevCode" },
    }).complete(USER);

    expect(requests[0].headers).not.toHaveProperty("authorization");
    expect(requests[0].headers["x-title"]).toBe("RevCode");
  });

  it("requests streaming usage and an event-stream response when streaming", async () => {
    const { requests } = stubFetch(() => sseResponse(dataFrames(chunk({ content: "x" }, "stop"))));

    await new OpenAiCompatClient(BASE).complete(USER, [], { onDelta: () => undefined });

    expect(requests[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(requests[0].headers.accept).toBe("text/event-stream");
  });

  it("serialises assistant tool calls and unwraps tool results", async () => {
    const { requests } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "" } }] }));
    const messages: LlmMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }],
      },
      {
        role: "tool",
        toolCallId: "c1",
        name: "read_file",
        content: JSON.stringify({
          toolCallId: "c1",
          name: "read_file",
          result: { path: "a.txt", content: "hello" },
        }),
      },
    ];

    await new OpenAiCompatClient(BASE).complete(messages);

    expect(requests[0].body.messages).toEqual([
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", name: "read_file", content: "a.txt\nhello" },
    ]);
  });

  it("sends multi-line tool results as plain text, not JSON-escaped", async () => {
    const { requests } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "" } }] }));
    const fileText = 'const a = "x";\n  return a;\n';

    await new OpenAiCompatClient(BASE).complete([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] },
      {
        role: "tool",
        toolCallId: "c1",
        name: "read_file",
        content: JSON.stringify({
          toolCallId: "c1",
          name: "read_file",
          result: { path: "src/a.ts", totalLines: 2, content: fileText },
        }),
      },
    ]);

    const sent = requests[0].body.messages as Array<{ role: string; content: string }>;
    expect(sent[2].content).toBe(`src/a.ts (2 lines)\n${fileText}`);
    expect(sent[2].content).not.toContain("\\n");
    expect(sent[2].content).not.toContain('\\"');
  });
});

describe("OpenAiCompatClient non-streaming response", () => {
  it("returns content, tool calls, reasoning, usage and finish reason", async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "Reading it.",
              reasoning_content: "I should read the file.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"a.txt"}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      }),
    );

    const response = await new OpenAiCompatClient(BASE).complete(USER, [READ_FILE]);

    expect(response).toEqual({
      content: "Reading it.",
      reasoning: "I should read the file.",
      toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 100 },
      finishReason: "tool_calls",
    });
  });

  it("maps length and stop finish reasons", async () => {
    stubFetch([
      () => jsonResponse({ choices: [{ message: { content: "cut" }, finish_reason: "length" }] }),
      () => jsonResponse({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }),
    ]);
    const client = new OpenAiCompatClient(BASE);

    expect((await client.complete(USER)).finishReason).toBe("length");
    expect((await client.complete(USER)).finishReason).toBe("stop");
  });

  it("recovers tool calls written as GLM XML in the content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content:
                "Let me look.\n<tool_call>read_file\n<arg_key>path</arg_key><arg_value>a.txt</arg_value></tool_call>",
            },
          },
        ],
      }),
    );

    const response = await new OpenAiCompatClient(BASE).complete(USER, [READ_FILE]);

    expect(response.content).toBe("Let me look.");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toMatchObject({ name: "read_file", arguments: { path: "a.txt" } });
    expect(response.finishReason).toBe("tool_calls");
    expect(warn).toHaveBeenCalled();
  });

  it("accepts object arguments and missing ids from lenient servers", async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ function: { name: "read_file", arguments: { path: "b.txt" } } }],
            },
          },
        ],
      }),
    );

    const response = await new OpenAiCompatClient(BASE).complete(USER, [READ_FILE]);

    expect(response.toolCalls[0].arguments).toEqual({ path: "b.txt" });
    expect(response.toolCalls[0].id).not.toBe("");
  });

  it("preserves unparseable arguments under `input`", async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                { id: "c", type: "function", function: { name: "read_file", arguments: "{oops" } },
              ],
            },
          },
        ],
      }),
    );

    const response = await new OpenAiCompatClient(BASE).complete(USER, [READ_FILE]);
    expect(response.toolCalls[0].arguments).toEqual({ input: "{oops" });
  });

  it("reports HTTP errors with the provider name, status and body", async () => {
    stubFetch(() => new Response('{"error":"bad key"}', { status: 401 }));

    await expect(new OpenAiCompatClient(BASE).complete(USER)).rejects.toThrow(
      'TestAI API request failed (401): {"error":"bad key"}',
    );
  });

  it("surfaces an error body returned with HTTP 200", async () => {
    stubFetch(() => jsonResponse({ error: { message: "model not found", code: 404 } }));

    await expect(new OpenAiCompatClient(BASE).complete(USER)).rejects.toThrow(
      "did not include a message: model not found (404)",
    );
  });
});

describe("OpenAiCompatClient streaming", () => {
  it("streams text and reasoning deltas and fills usage and finishReason", async () => {
    const { response, deltas } = await stream([
      ...dataFrames(
        chunk({ role: "assistant", content: "" }),
        chunk({ reasoning_content: "think " }),
        chunk({ reasoning_content: "hard" }),
        chunk({ content: "Hel" }),
        chunk({ content: "lo" }, "stop"),
        {
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 8 } },
        },
      ),
      "data: [DONE]\n\n",
    ]);

    expect(deltas).toEqual([
      { reasoning: "think " },
      { reasoning: "hard" },
      { text: "Hel" },
      { text: "lo" },
    ]);
    expect(response).toEqual({
      content: "Hello",
      reasoning: "think hard",
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 8 },
      finishReason: "stop",
    });
  });

  it("accepts the reasoning field used by OpenRouter and Ollama", async () => {
    const { response } = await stream(dataFrames(chunk({ reasoning: "hmm" }), chunk({ content: "a" }, "stop")));
    expect(response.reasoning).toBe("hmm");
  });

  it("survives frames split across arbitrary read boundaries", async () => {
    const whole = dataFrames(chunk({ content: "Hello" }), chunk({ content: " world" }, "stop")).join("");
    const pieces = whole.match(/[\s\S]{1,7}/g) ?? [];

    const { response } = await stream(pieces);
    expect(response.content).toBe("Hello world");
  });

  it("maps a length finish reason", async () => {
    const { response } = await stream(dataFrames(chunk({ content: "trunc" }, "length")));
    expect(response.finishReason).toBe("length");
  });

  it("ignores SSE comments and non-JSON keep-alive frames", async () => {
    const { response } = await stream([
      ": OPENROUTER PROCESSING\n\n",
      "data: not json\n\n",
      ...dataFrames(chunk({ content: "ok" }, "stop")),
    ]);
    expect(response.content).toBe("ok");
  });

  describe("tool call accumulation", () => {
    it("joins argument fragments when id/name only appear in the first chunk", async () => {
      const { response } = await stream(
        dataFrames(
          toolFragment({ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }),
          toolFragment({ index: 0, function: { arguments: '{"pa' } }),
          toolFragment({ index: 0, function: { arguments: 'th": "src/' } }),
          toolFragment({ index: 0, function: { arguments: 'a.ts"}' } }, "tool_calls"),
        ),
      );

      expect(response.toolCalls).toEqual([
        { id: "call_a", name: "read_file", arguments: { path: "src/a.ts" } },
      ]);
      expect(response.finishReason).toBe("tool_calls");
    });

    it("does not duplicate id and name when a server resends them in every chunk", async () => {
      const { response } = await stream(
        dataFrames(
          toolFragment({ index: 0, id: "call_a", function: { name: "read_file", arguments: '{"path"' } }),
          toolFragment({ index: 0, id: "call_a", function: { name: "read_file", arguments: ':"x"}' } }),
        ),
      );

      expect(response.toolCalls).toEqual([
        { id: "call_a", name: "read_file", arguments: { path: "x" } },
      ]);
    });

    it("tracks calls by id when the server omits index", async () => {
      const { response } = await stream(
        dataFrames(
          toolFragment({ id: "call_a", function: { name: "read_file", arguments: '{"path"' } }),
          toolFragment({ id: "call_a", function: { arguments: ':"a"}' } }),
          toolFragment({ id: "call_b", function: { name: "read_file", arguments: '{"path"' } }),
          toolFragment({ id: "call_b", function: { arguments: ':"b"}' } }),
        ),
      );

      expect(response.toolCalls.map((call) => [call.id, call.arguments])).toEqual([
        ["call_a", { path: "a" }],
        ["call_b", { path: "b" }],
      ]);
    });

    it("follows continuation fragments that carry neither index nor id", async () => {
      const { response } = await stream(
        dataFrames(
          toolFragment({ id: "call_a", function: { name: "read_file", arguments: '{"pa' } }),
          toolFragment({ function: { arguments: 'th":"a"}' } }),
        ),
      );

      expect(response.toolCalls).toEqual([
        { id: "call_a", name: "read_file", arguments: { path: "a" } },
      ]);
    });

    it("splits back-to-back calls that have no index and no id by name or completed JSON", async () => {
      const { response } = await stream(
        dataFrames(
          toolFragment({ function: { name: "read_file", arguments: '{"path":"a"}' } }),
          toolFragment({ function: { name: "read_file", arguments: '{"path":"b"}' } }),
          toolFragment({ function: { name: "list_directory", arguments: "{}" } }),
        ),
      );

      expect(response.toolCalls.map((call) => [call.name, call.arguments])).toEqual([
        ["read_file", { path: "a" }],
        ["read_file", { path: "b" }],
        ["list_directory", {}],
      ]);
    });

    it("keeps parallel calls apart when their fragments interleave", async () => {
      const { response } = await stream(
        dataFrames(
          toolFragment({ index: 0, id: "c0", function: { name: "read_file", arguments: '{"path":' } }),
          toolFragment({ index: 1, id: "c1", function: { name: "read_file", arguments: '{"path":' } }),
          toolFragment({ index: 1, function: { arguments: '"two"}' } }),
          toolFragment({ index: 0, function: { arguments: '"one"}' } }),
        ),
      );

      expect(response.toolCalls).toEqual([
        { id: "c0", name: "read_file", arguments: { path: "one" } },
        { id: "c1", name: "read_file", arguments: { path: "two" } },
      ]);
    });

    it("separates calls that reuse index 0 but carry distinct ids", async () => {
      const { response } = await stream(
        dataFrames(
          toolFragment({ index: 0, id: "c0", function: { name: "read_file", arguments: '{"path":"a"}' } }),
          toolFragment({ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"b"}' } }),
        ),
      );

      expect(response.toolCalls.map((call) => [call.id, call.arguments])).toEqual([
        ["c0", { path: "a" }],
        ["c1", { path: "b" }],
      ]);
    });

    it("turns empty argument text into an empty object and invents a missing id", async () => {
      const { response } = await stream(
        dataFrames(toolFragment({ index: 0, function: { name: "list_directory" } }, "tool_calls")),
      );

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0]).toMatchObject({ name: "list_directory", arguments: {} });
      expect(response.toolCalls[0].id).not.toBe("");
    });

    it("reports tool_calls even when the server says finish_reason stop", async () => {
      const { response } = await stream(
        dataFrames(
          toolFragment({ index: 0, id: "c0", function: { name: "read_file", arguments: '{"path":"a"}' } }),
          chunk({}, "stop"),
        ),
      );
      expect(response.finishReason).toBe("tool_calls");
    });

    it("keeps length when a truncated response still carries a tool call", async () => {
      const { response } = await stream(
        dataFrames(
          toolFragment({ index: 0, id: "c0", function: { name: "read_file", arguments: '{"path":"a' } }),
          chunk({}, "length"),
        ),
      );
      expect(response.finishReason).toBe("length");
      expect(response.toolCalls[0].arguments).toEqual({ input: '{"path":"a' });
    });
  });

  it("recovers GLM XML tool calls from streamed content", async () => {
    const xml = "<tool_call>read_file\n<arg_key>path</arg_key><arg_value>a.txt</arg_value></tool_call>";
    const { response, deltas } = await stream(
      dataFrames(chunk({ content: "Ok. " }), chunk({ content: xml }, "stop")),
    );

    expect(deltas.map((delta) => delta.text).join("")).toContain("<tool_call>");
    expect(response.content).toBe("Ok.");
    expect(response.toolCalls[0]).toMatchObject({ name: "read_file", arguments: { path: "a.txt" } });
  });

  it("throws on an in-band error frame", async () => {
    stubFetch(() => sseResponse(dataFrames({ error: { message: "overloaded", code: 529 } })));

    await expect(
      new OpenAiCompatClient(BASE).complete(USER, [], { onDelta: () => undefined }),
    ).rejects.toThrow("TestAI stream error: overloaded (529)");
  });

  it("reports HTTP failures before the stream starts", async () => {
    stubFetch(() => new Response("nope", { status: 400 }));

    await expect(
      new OpenAiCompatClient(BASE).complete(USER, [], { onDelta: () => undefined }),
    ).rejects.toThrow("TestAI API request failed (400): nope");
  });
});

describe("OpenAiCompatClient mid-stream failure", () => {
  it("wraps a failure that happens after text was emitted", async () => {
    stubFetch(() =>
      sseResponse(dataFrames(chunk({ content: "partial" })), { failWith: new Error("socket closed") }),
    );

    await expect(
      new OpenAiCompatClient(BASE).complete(USER, [], { onDelta: () => undefined }),
    ).rejects.toThrow("TestAI stream interrupted after partial output: socket closed");
  });

  it("rethrows the original error when no text was emitted yet", async () => {
    stubFetch(() =>
      sseResponse(dataFrames(chunk({ reasoning_content: "thinking" })), {
        failWith: new Error("socket closed"),
      }),
    );

    const error = await new OpenAiCompatClient(BASE)
      .complete(USER, [], { onDelta: () => undefined })
      .catch((e: unknown) => e);

    expect((error as Error).message).toBe("socket closed");
  });
});

describe("OpenAiCompatClient abort", () => {
  it("rejects with AbortError and never calls fetch for an already-aborted signal", async () => {
    const { requests } = stubFetch(() => jsonResponse({ choices: [] }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      new OpenAiCompatClient(BASE).complete(USER, [], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(0);
  });

  it("passes the signal to fetch", async () => {
    const { requests } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "" } }] }));
    const controller = new AbortController();

    await new OpenAiCompatClient(BASE).complete(USER, [], { signal: controller.signal });

    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    expect(requests[0].signal?.aborted).toBe(false);
    controller.abort();
    expect(requests[0].signal?.aborted).toBe(true);
  });

  it("aborts a stream that has gone quiet after emitting text, without wrapping the error", async () => {
    stubFetch(() => sseResponse(dataFrames(chunk({ content: "partial" })), { hang: true }));
    const controller = new AbortController();
    const deltas: LlmStreamDelta[] = [];

    const pending = new OpenAiCompatClient(BASE).complete(USER, [], {
      signal: controller.signal,
      onDelta: (delta) => {
        deltas.push(delta);
        controller.abort();
      },
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(deltas).toEqual([{ text: "partial" }]);
  });

  it("reports AbortError (not a wrapped interruption) for an abort with a custom reason", async () => {
    stubFetch(() => sseResponse(dataFrames(chunk({ content: "partial" })), { hang: true }));
    const controller = new AbortController();

    const pending = new OpenAiCompatClient(BASE).complete(USER, [], {
      signal: controller.signal,
      onDelta: () => controller.abort(new Error("esc")),
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
