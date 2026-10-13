import { describe, expect, it } from "vitest";
import { asBoolean, asString, asStringList, parseFrontmatter } from "./frontmatter.js";

const doc = (...yaml: string[]) => `---\n${yaml.join("\n")}\n---\nBody text\n`;

describe("parseFrontmatter", () => {
  it("reports documents without frontmatter and returns them as the body", () => {
    const parsed = parseFrontmatter("# Title\n\ntext\n");
    expect(parsed).toEqual({ data: {}, body: "# Title\n\ntext\n", present: false });
  });

  it("parses scalars, booleans, null and keeps numbers as strings", () => {
    const parsed = parseFrontmatter(
      doc("name: my-skill", "flag: true", "off: False", "nothing: null", "tilde: ~", "version: 1.10", "empty:"),
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual({
      name: "my-skill",
      flag: true,
      off: false,
      nothing: null,
      tilde: null,
      version: "1.10",
      empty: null,
    });
    expect(parsed.body).toBe("Body text\n");
  });

  it("is forgiving about colons and brackets inside plain scalars", () => {
    const parsed = parseFrontmatter(
      doc("description: Fix: the build (see https://x.dev/a?b=c)", "title: [WIP] cleanup the thing"),
    );
    expect(parsed.data.description).toBe("Fix: the build (see https://x.dev/a?b=c)");
    expect(parsed.data.title).toBe("[WIP] cleanup the thing");
  });

  it("strips trailing comments from plain scalars but not from quoted ones", () => {
    const parsed = parseFrontmatter(doc("a: value # comment", 'b: "keep # this"', "c: has#hash"));
    expect(parsed.data).toEqual({ a: "value", b: "keep # this", c: "has#hash" });
  });

  it("handles double and single quoted strings with escapes", () => {
    const parsed = parseFrontmatter(
      doc(
        'a: "line1\\nline2 \\"quoted\\" \\u00e9"',
        "b: 'it''s fine'",
        'c: "regex \\d+ stays"',
        "d: \"\"",
        "'quoted key': x",
      ),
    );
    expect(parsed.data.a).toBe('line1\nline2 "quoted" é');
    expect(parsed.data.b).toBe("it's fine");
    expect(parsed.data.c).toBe("regex \\d+ stays");
    expect(parsed.data.d).toBe("");
    expect(parsed.data["quoted key"]).toBe("x");
  });

  it("folds quoted strings that span lines", () => {
    const parsed = parseFrontmatter(doc('description: "first part', "  second part", "", '  after blank"', "next: ok"));
    expect(parsed.data.description).toBe("first part second part\nafter blank");
    expect(parsed.data.next).toBe("ok");
  });

  it("folds plain scalars continued on indented lines", () => {
    const parsed = parseFrontmatter(doc("description: Use when the user", "  asks about PDFs", "name: pdf"));
    expect(parsed.data.description).toBe("Use when the user asks about PDFs");
    expect(parsed.data.name).toBe("pdf");
  });

  it("parses block scalars with clip, strip and keep chomping", () => {
    const parsed = parseFrontmatter(
      doc("lit: |", "  line one", "    indented", "  line three", "strip: |-", "  no newline", "keep: |+", "  kept", "", "after: x"),
    );
    expect(parsed.data.lit).toBe("line one\n  indented\nline three\n");
    expect(parsed.data.strip).toBe("no newline");
    expect(parsed.data.keep).toBe("kept\n\n");
    expect(parsed.data.after).toBe("x");
  });

  it("folds > block scalars: single breaks join, blank lines separate paragraphs", () => {
    const parsed = parseFrontmatter(
      doc("description: >", "  Use this skill when", "  working with PDFs.", "", "  Second paragraph.", "next: y"),
    );
    expect(parsed.data.description).toBe("Use this skill when working with PDFs.\nSecond paragraph.\n");
    expect(parsed.data.next).toBe("y");

    const stripped = parseFrontmatter(doc("d: >-", "  a", "  b"));
    expect(stripped.data.d).toBe("a b");
  });

  it("parses block lists, including a list at the same indent as its key", () => {
    const parsed = parseFrontmatter(
      doc("tools:", "  - Read", "  - 'Bash(git add:*)'", "same:", "- one", "- two # note", "last: z"),
    );
    expect(parsed.data.tools).toEqual(["Read", "Bash(git add:*)"]);
    expect(parsed.data.same).toEqual(["one", "two"]);
    expect(parsed.data.last).toBe("z");
  });

  it("parses inline lists, quoted items with commas, trailing commas and multi-line lists", () => {
    const parsed = parseFrontmatter(
      doc('a: [Read, "Grep, Glob", true]', "b: []", "c: [x, y,]", "d: [", "  p,", "  q", "]", "e: z"),
    );
    expect(parsed.data.a).toEqual(["Read", "Grep, Glob", true]);
    expect(parsed.data.b).toEqual([]);
    expect(parsed.data.c).toEqual(["x", "y"]);
    expect(parsed.data.d).toEqual(["p", "q"]);
    expect(parsed.data.e).toBe("z");
  });

  it("parses nested mappings", () => {
    const parsed = parseFrontmatter(doc("name: x", "metadata:", "  author: me", "  version: \"1\"", "  nested:", "    deep: yes", "tail: t"));
    expect(parsed.data).toEqual({
      name: "x",
      metadata: { author: "me", version: "1", nested: { deep: "yes" } },
      tail: "t",
    });
  });

  it("ignores comment lines and blank lines between keys", () => {
    const parsed = parseFrontmatter(doc("# leading comment", "a: 1", "", "  # indented comment", "b: 2"));
    expect(parsed.data).toEqual({ a: "1", b: "2" });
  });

  it("tolerates a BOM and CRLF line endings", () => {
    const parsed = parseFrontmatter("﻿---\r\nname: win\r\ndescription: |\r\n  a\r\n  b\r\n---\r\nBody\r\nmore\r\n");
    expect(parsed.data).toEqual({ name: "win", description: "a\nb\n" });
    expect(parsed.body).toBe("Body\nmore\n");
  });

  it("accepts an empty frontmatter block", () => {
    const parsed = parseFrontmatter("---\n---\nBody");
    expect(parsed).toEqual({ data: {}, body: "Body", present: true });
  });

  it("does not let a __proto__ key replace the prototype", () => {
    const parsed = parseFrontmatter(doc("__proto__: evil", "name: x"));
    expect(Object.getPrototypeOf(parsed.data)).toBe(Object.prototype);
    expect(parsed.data).toEqual({ name: "x" });
  });

  it.each([
    ["unterminated block", "---\nname: x\nBody with no closing delimiter\n", /not closed/],
    ["a line that is not key: value", doc("name: x", "just words here"), /key: value.*line 3/],
    ["a top-level list", doc("- a", "- b"), /mapping/],
    ["text after a closing quote", doc('name: "x" trailing'), /after the closing quote/],
    ["an unterminated quote", doc('name: "never closed', "other: y"), /unterminated/],
    ["unexpected indentation", doc('a: "x"', "   b: 2"), /indentation/],
  ])("reports an error for %s", (_label, text, pattern) => {
    const parsed = parseFrontmatter(text);
    expect(parsed.present).toBe(true);
    expect(parsed.error).toMatch(pattern);
    expect(parsed.data).toEqual({});
  });

  it("still returns the body when the YAML inside is malformed", () => {
    const parsed = parseFrontmatter(doc("garbage line"));
    expect(parsed.error).toBeDefined();
    expect(parsed.body).toBe("Body text\n");
  });
});

describe("typed accessors", () => {
  it("asString only accepts scalars", () => {
    expect(asString("x")).toBe("x");
    expect(asString(true)).toBe("true");
    expect(asString(null)).toBeUndefined();
    expect(asString(["a"])).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
  });

  it("asBoolean understands booleans and yes/no strings", () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean("Yes")).toBe(true);
    expect(asBoolean("false")).toBe(false);
    expect(asBoolean("maybe")).toBeUndefined();
    expect(asBoolean(undefined)).toBeUndefined();
  });

  it("asStringList splits strings on commas and whitespace but respects parentheses", () => {
    expect(asStringList("Read, Grep Glob")).toEqual(["Read", "Grep", "Glob"]);
    expect(asStringList("Bash(git add:*), Read")).toEqual(["Bash(git add:*)", "Read"]);
    expect(asStringList(["Read", " Grep ", ""])).toEqual(["Read", "Grep"]);
    expect(asStringList(undefined)).toEqual([]);
  });
});
