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
