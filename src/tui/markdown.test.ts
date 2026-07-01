import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansi.js";
import { MarkdownStream, renderMarkdown } from "./markdown.js";

describe("renderMarkdown (plain)", () => {
  it("passes text through unchanged when not rich", () => {
    expect(renderMarkdown("# Title\n- a\n- b", false)).toBe("# Title\n- a\n- b");
  });
});

describe("renderMarkdown (rich)", () => {
  it("emits ANSI but preserves the visible text of a heading", () => {
    const out = renderMarkdown("# Hello", true);
    expect(out).not.toBe("# Hello");
    expect(stripAnsi(out)).toBe("Hello");
  });

  it("turns bullets into • markers", () => {
    const out = stripAnsi(renderMarkdown("- one\n- two", true));
    expect(out).toContain("• one");
    expect(out).toContain("• two");
  });

  it("keeps fenced code content verbatim (sans fence lines)", () => {
    const out = stripAnsi(renderMarkdown("```js\nconst x = 1;\n```", true));
    expect(out).toContain("const x = 1;");
  });
});

describe("MarkdownStream", () => {
  it("emits completed lines on newline and buffers the remainder", () => {
    const stream = new MarkdownStream(false);
    expect(stream.push("hello ")).toBe("");
    expect(stream.push("world\nnext")).toBe("hello world\n");
    expect(stream.flush()).toBe("next");
  });

  it("reassembles the same text regardless of chunk boundaries", () => {
    const text = "# Title\nbody line\n- item\n";
    const whole = renderMarkdown(text, true);

    const stream = new MarkdownStream(true);
    let out = "";
    for (const ch of text) {
      out += stream.push(ch);
    }
    out += stream.flush();
    expect(out).toBe(whole);
  });
});
