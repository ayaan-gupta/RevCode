import { describe, expect, it } from "vitest";

import { convertToolResult } from "./tool-result.js";

describe("convertToolResult", () => {
  it("joins text blocks", () => {
    expect(
      convertToolResult({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toEqual({ text: "one\ntwo" });
  });

  it("returns { error } when isError is set", () => {
    expect(convertToolResult({ isError: true, content: [{ type: "text", text: "bad input" }] })).toEqual({
      error: "bad input",
    });
    expect(convertToolResult({ isError: true, content: [] })).toEqual({
      error: "The MCP tool reported an error without a message.",
    });
  });

  it("replaces image and audio with placeholders that say what was dropped", () => {
    const data = "A".repeat(12345);
    const out = convertToolResult({
      content: [
        { type: "image", data, mimeType: "image/png" },
        { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      ],
    });
    expect(out.text).toBe("[image: image/png, 12345 bytes base64 omitted]\n[audio: audio/wav, 4 bytes base64 omitted]");
    expect(JSON.stringify(out)).not.toContain(data);
  });

  it("keeps embedded text resources and placeholders blob resources and links", () => {
    const out = convertToolResult({
      content: [
        { type: "resource", resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "contents" } },
        { type: "resource", resource: { uri: "file:///b.bin", mimeType: "application/octet-stream", blob: "AAAAAAAA" } },
        { type: "resource_link", uri: "https://x.test/doc", name: "doc", description: "A doc" },
      ],
    });
    expect(out.text).toBe(
      [
        "[resource: file:///a.txt (text/plain)]\ncontents",
        "[resource file:///b.bin: application/octet-stream, 8 bytes base64 omitted]",
        "[resource_link: https://x.test/doc (doc) - A doc]",
      ].join("\n"),
    );
  });

  it("includes structuredContent as `structured`", () => {
    expect(
      convertToolResult({ content: [{ type: "text", text: "The sum is 3" }], structuredContent: { sum: 3 } }),
    ).toEqual({ text: "The sum is 3", structured: { sum: 3 } });
  });

  it("drops text that is only a JSON echo of structuredContent", () => {
    expect(
      convertToolResult({ content: [{ type: "text", text: '{"sum":3}' }], structuredContent: { sum: 3 } }),
    ).toEqual({ structured: { sum: 3 } });
    expect(
      convertToolResult({
        content: [{ type: "text", text: '{\n  "b": 2,\n  "a": 1\n}' }],
        structuredContent: { a: 1, b: 2 },
      }),
    ).toEqual({ structured: { a: 1, b: 2 } });
  });

  it("keeps structured data on errors too", () => {
    expect(
      convertToolResult({ isError: true, content: [{ type: "text", text: "nope" }], structuredContent: { code: 4 } }),
    ).toEqual({ error: "nope", structured: { code: 4 } });
  });

  it("tolerates malformed results", () => {
    expect(convertToolResult(undefined)).toEqual({ text: "" });
    expect(convertToolResult({ content: "text" })).toEqual({ text: "" });
    expect(convertToolResult({ content: [null, 5, { type: "mystery" }] })).toEqual({
      text: "[unsupported content type: mystery]",
    });
  });
});
