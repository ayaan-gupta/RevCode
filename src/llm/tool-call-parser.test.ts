import { describe, expect, it } from "vitest";
import {
  extractToolCalls,
  parseGlmXmlToolCalls,
  parseInlineJsonToolCalls,
} from "./tool-call-parser.js";

const tools = [
  {
    name: "read_file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "shell",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
];

describe("parseGlmXmlToolCalls", () => {
  it("parses GLM XML tool calls", () => {
    const content = `<tool_call>read_file
<arg_key>path</arg_key>
<arg_value>src/app.ts</arg_value>
</tool_call>`;

    const calls = parseGlmXmlToolCalls(content, tools);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].arguments).toEqual({ path: "src/app.ts" });
  });
});

describe("parseInlineJsonToolCalls", () => {
  it("parses inline JSON tool calls", () => {
    const content = '{"tool_call":{"name":"shell","arguments":{"command":"ls"}}}';
    const calls = parseInlineJsonToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("shell");
    expect(calls[0].arguments).toEqual({ command: "ls" });
  });
});

describe("extractToolCalls", () => {
  it("prefers API tool_calls when present", () => {
    const result = extractToolCalls({
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      content: '<tool_call>shell\n<arg_key>command</arg_key><arg_value>ls</arg_value></tool_call>',
      tools,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read_file");
    expect(result.usedFallback).toBe(false);
  });

  it("falls back to XML parsing when API tool_calls are empty", () => {
    const content = `<tool_call>read_file
<arg_key>path</arg_key>
<arg_value>README.md</arg_value>
</tool_call>`;

    const result = extractToolCalls({
      toolCalls: [],
      content,
      tools,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments).toEqual({ path: "README.md" });
    expect(result.content).toBe("");
    expect(result.usedFallback).toBe(true);
  });

  it("falls back to inline JSON when XML is absent", () => {
    const result = extractToolCalls({
      toolCalls: [],
      content: '{"tool_call":{"name":"shell","arguments":{"command":"ls"}}}',
      tools,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("shell");
    expect(result.usedFallback).toBe(true);
  });
});

describe("additional tool-call dialects", () => {
  const tools = [
    { name: "shell", parameters: { properties: { command: { type: "string" }, timeout: { type: "integer" } } } },
    { name: "write_file", parameters: { properties: { path: { type: "string" }, content: { type: "string" } } } },
  ];

  it("parses Hermes/Qwen JSON inside <tool_call>", () => {
    const out = extractToolCalls({
      toolCalls: [],
      tools,
      content: 'I will run it.\n<tool_call>\n{"name": "shell", "arguments": {"command": "ls -la", "timeout": 5}}\n</tool_call>',
    });
    expect(out.usedFallback).toBe(true);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toMatchObject({ name: "shell", arguments: { command: "ls -la", timeout: 5 } });
    expect(out.content).toBe("I will run it.");
  });

  it("accepts string-encoded arguments in Hermes JSON", () => {
    const out = extractToolCalls({
      toolCalls: [],
      tools,
      content: '<tool_call>{"name":"shell","arguments":"{\\"command\\":\\"pwd\\"}"}</tool_call>',
    });
    expect(out.toolCalls[0].arguments).toEqual({ command: "pwd" });
  });

  it("parses Qwen3-Coder <function=…><parameter=…> blocks, preserving multi-line values", () => {
    const content = `<tool_call>
<function=write_file>
<parameter=path>
app.py
</parameter>
<parameter=content>
def f():
    return 1
</parameter>
</function>
</tool_call>`;
    const out = extractToolCalls({ toolCalls: [], tools, content });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].name).toBe("write_file");
    expect(out.toolCalls[0].arguments).toEqual({ path: "app.py", content: "def f():\n    return 1" });
    expect(out.content).toBe("");
  });

  it("strips <think> blocks from content, including an unclosed-opening variant", () => {
    expect(extractToolCalls({ toolCalls: [], tools, content: "<think>hmm let me see</think>The answer is 4." }).content).toBe("The answer is 4.");
    expect(extractToolCalls({ toolCalls: [], tools, content: "reasoning only…</think>Final." }).content).toBe("Final.");
  });

  it("still prefers structured tool calls and cleans markup from their content", () => {
    const call = { id: "1", name: "shell", arguments: { command: "ls" } };
    const out = extractToolCalls({ toolCalls: [call], tools, content: "<think>x</think>ok" });
    expect(out.toolCalls).toEqual([call]);
    expect(out.content).toBe("ok");
    expect(out.usedFallback).toBe(false);
  });
});
