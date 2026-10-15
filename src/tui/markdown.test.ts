import { describe, expect, it } from "vitest";
import { MarkdownStream, renderInline, renderMarkdownRows } from "./markdown.js";
import { plainStyle, Style } from "./style.js";
import { stripAnsi, visibleWidth } from "./width.js";

const plain = plainStyle();
const color = new Style({ colorDepth: 24, theme: "dark", unicode: true, hyperlinks: false });
const rows = (text: string, width = 40, style = plain): string[] => renderMarkdownRows(text, { style, width });

describe("renderInline", () => {
  it("styles code, bold, italic and strikethrough", () => {
    expect(renderInline("a `code` b", color)).toContain("38;2;");
    expect(stripAnsi(renderInline("a `code` **bold** *it* ~~gone~~", color))).toBe("a code bold it gone");
    expect(renderInline("**bold**", color)).toContain("\u001b[1m");
    expect(renderInline("*it*", color)).toContain("\u001b[3m");
  });

  it("does not treat snake_case or math-like asterisks as emphasis", () => {
    expect(renderInline("snake_case_name and 2 * 3 * 4", color)).toBe("snake_case_name and 2 * 3 * 4");
  });

  it("nests bold inside italics and keeps the outer style", () => {
    const out = renderInline("*a **b** c*", color);
    expect(stripAnsi(out)).toBe("a b c");
    expect(out).toContain("\u001b[3m");
    expect(out).toContain("\u001b[1m");
  });

  it("handles code spans containing markers and double backticks", () => {
    expect(stripAnsi(renderInline("`a*b*` and ``x`y``", color))).toBe("a*b* and x`y");
  });

  it("renders links with the URL in parentheses when hyperlinks are unsupported", () => {
    expect(stripAnsi(renderInline("see [docs](https://x.test/a) now", color))).toBe("see docs (https://x.test/a) now");
    expect(stripAnsi(renderInline("[https://x.test](https://x.test)", color))).toBe("https://x.test");
  });

  it("uses OSC 8 hyperlinks when supported", () => {
    const linked = new Style({ colorDepth: 24, theme: "dark", unicode: true, hyperlinks: true });
    const out = renderInline("[docs](https://x.test)", linked);
    expect(out).toContain("\u001b]8;;https://x.test");
    expect(stripAnsi(out)).toBe("docs");
  });

  it("recognizes bare URLs and leaves trailing punctuation out", () => {
    const out = renderInline("go to https://example.com/a_b.", color);
    expect(stripAnsi(out)).toBe("go to https://example.com/a_b.");
    expect(out).toContain("\u001b[4m");
    expect(out.endsWith(".")).toBe(true);
  });

  it("handles escapes and images", () => {
    expect(renderInline("\\*not bold\\*", color)).toBe("*not bold*");
    expect(stripAnsi(renderInline("![logo](x.png)", color))).toBe("[image: logo]");
  });

  it("returns plain text untouched", () => {
    expect(renderInline("just words", color)).toBe("just words");
  });
});

describe("renderMarkdownRows: blocks", () => {
  it("wraps paragraphs to the width", () => {
    const out = rows("the quick brown fox jumps over the lazy dog again and again", 24);
    expect(out.length).toBeGreaterThan(2);
    for (const row of out) expect(visibleWidth(row)).toBeLessThanOrEqual(24);
  });

  it("renders bullet and numbered lists with hanging indents", () => {
    const out = rows("- first item that is long enough to wrap around\n  - nested\n1. one\n2. two", 24);
    expect(out[0]).toBe("• first item that is");
    expect(out[1]).toBe("  long enough to wrap");
    expect(out).toContain("  ◦ nested");
    expect(out).toContain("1. one");
    expect(out).toContain("2. two");
  });

  it("renders task lists", () => {
    expect(rows("- [ ] todo\n- [x] done")).toEqual(["☐ todo", "☑ done"]);
  });

  it("renders blockquotes with a bar and wraps inside it", () => {
    const out = rows("> a quote that is long enough to wrap onto more lines", 20);
    expect(out.every((r) => r.startsWith("▎ "))).toBe(true);
    expect(out.length).toBeGreaterThan(1);
  });

  it("renders headings and horizontal rules, with spacing before headings", () => {
    const out = rows("intro\n## Title\ntext\n---\nmore");
    expect(out.slice(0, 4)).toEqual(["intro", "", "Title", "text"]);
    expect(out[4]).toBe("");
    expect(out[5]).toMatch(/^─+$/);
    expect(out[6]).toBe("more");
  });

  it("collapses runs of blank lines", () => {
    expect(rows("a\n\n\n\nb")).toEqual(["a", "", "b"]);
  });

  it("renders fenced code in a gutter without interpreting markdown inside", () => {
    const out = rows("```ts\nconst a = **x**;\n```");
    expect(out[0]).toMatch(/^╭─ ts ─+$/);
    expect(out[1]).toBe("│ const a = **x**;");
    expect(out[2]).toMatch(/^╰─+$/);
  });

  it("highlights code when color is on", () => {
    const out = rows("```js\nconst a = 1; // hi\n```", 40, color).join("\n");
    expect(out).toContain("38;2;");
    expect(stripAnsi(out)).toContain("const a = 1; // hi");
  });

  it("handles an unterminated fence at the end of the stream", () => {
    const out = rows("```py\nprint(1)");
    expect(out.at(-1)).toMatch(/^╰/);
  });

  it("respects longer fences and tilde fences", () => {
    const out = rows("````\n```\ninner\n```\n````");
    expect(out.filter((r) => r.startsWith("│ "))).toEqual(["│ ```", "│ inner", "│ ```"]);
  });
});

describe("renderMarkdownRows: tables", () => {
  const table = "| Name | Qty |\n|:-----|----:|\n| apple | 3 |\n| kiwi | 12 |";

  it("draws an aligned box table", () => {
    const out = rows(table, 40);
    expect(out[0]).toBe("┌───────┬─────┐");
    expect(out[1]).toBe("│ Name  │ Qty │");
    expect(out[2]).toBe("├───────┼─────┤");
    expect(out[3]).toBe("│ apple │   3 │");
    expect(out[4]).toBe("│ kiwi  │  12 │");
    expect(out[5]).toBe("└───────┴─────┘");
  });

  it("wraps cells when the table is too wide, never exceeding the width", () => {
    const wide = "| Feature | Description |\n|---|---|\n| streaming | renders tokens as they arrive without waiting for the whole response |";
    const out = rows(wide, 40);
    for (const row of out) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
    expect(out.join("\n")).toContain("streaming");
  });

  it("stacks rows when the terminal is too narrow for a grid", () => {
    const cols = "| aaaaaaaaaa | bbbbbbbbbb | cccccccccc | dddddddddd |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |";
    const out = rows(cols, 30);
    expect(out.join("\n")).toContain("aaaaaaaaaa: 1");
  });

  it("does not mistake prose with a pipe for a table", () => {
    expect(rows("use a | b to pipe")).toEqual(["use a | b to pipe"]);
  });

  it("renders a table followed by text", () => {
    const out = rows(`${table}\nafter`);
    expect(out.at(-1)).toBe("after");
    expect(out).toContain("");
  });
});

describe("MarkdownStream", () => {
  it("emits finished lines as they complete and keeps the partial line as the tail", () => {
    const stream = new MarkdownStream({ style: plain, width: 40 });
    expect(stream.push("Hello wor")).toEqual({ lines: [], tail: "Hello wor" });
    expect(stream.push("ld\nSecond")).toEqual({ lines: ["Hello world"], tail: "Second" });
    expect(stream.flush()).toEqual(["Second"]);
  });

  it("produces the same rows regardless of how the input is chunked", () => {
    const text = "# Title\n\nSome **bold** text with `code` and a long enough sentence to wrap around.\n\n- a\n- b\n\n```ts\nlet x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend\n";
    const whole = renderMarkdownRows(text, { style: plain, width: 30 });
    for (const size of [1, 2, 3, 7, 13]) {
      const stream = new MarkdownStream({ style: plain, width: 30 });
      const out: string[] = [];
      for (let i = 0; i < text.length; i += size) out.push(...stream.push(text.slice(i, i + size)).lines);
      out.push(...stream.flush());
      expect(out).toEqual(whole);
    }
  });

  it("commits long paragraph rows while the line is still streaming", () => {
    const stream = new MarkdownStream({ style: plain, width: 20 });
    const sentence = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
    const emitted: string[] = [];
    for (let i = 0; i < sentence.length; i += 5) emitted.push(...stream.push(sentence.slice(i, i + 5)).lines);
    expect(emitted.length).toBeGreaterThan(0); // rows were committed before any newline arrived
    const rest = stream.push("\n");
    const all = [...emitted, ...rest.lines, ...stream.flush()];
    expect(all).toEqual(renderMarkdownRows(sentence, { style: plain, width: 20 }));
  });

  it("holds a possible table header until the next line decides", () => {
    const stream = new MarkdownStream({ style: plain, width: 40 });
    expect(stream.push("| a | b |\n").lines).toEqual([]);
    const next = stream.push("not a separator\n");
    expect(next.lines).toEqual(["| a | b |", "not a separator"]);
  });

  it("shows code lines in the tail with the gutter", () => {
    const stream = new MarkdownStream({ style: plain, width: 40 });
    stream.push("```js\n");
    expect(stream.push("const x").tail).toBe("│ const x");
  });
});

describe("MarkdownStream: very long lines", () => {
  it("streams a huge single line without quadratic slowdown and renders the same rows at the end", () => {
    const sentence = "The quick brown fox jumps over the lazy dog while **bold** and `code` keep coming. ";
    const text = sentence.repeat(500); // ~40 KB without a newline
    const started = Date.now();
    const stream = new MarkdownStream({ style: plain, width: 80 });
    const out: string[] = [];
    for (let i = 0; i < text.length; i += 4) out.push(...stream.push(text.slice(i, i + 4)).lines);
    out.push(...stream.flush());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out).toEqual(renderMarkdownRows(text, { style: plain, width: 80 }));
  });

  it("shows the latest raw text as the tail once the line is too long to re-render per token", () => {
    const stream = new MarkdownStream({ style: plain, width: 80 });
    const result = stream.push("word ".repeat(1500));
    expect(result.tail.startsWith("…")).toBe(true);
    expect(result.tail.length).toBeLessThan(200);
  });
});
