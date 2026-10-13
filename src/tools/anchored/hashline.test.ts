import { describe, expect, it } from "vitest";
import {
  anchorLine,
  applyHashlineEdits,
  formatLineTag,
  HashlineMismatchError,
  lineId,
  normalizeContent,
  parseTag,
  renderAnchoredLines,
  renderAnchoredRegions,
  splitAnchoredLines,
  type HashlineEdit,
} from "./hashline.js";
import { xxh32 } from "./xxh32.js";

const SOURCE = "import a from 'a';\n\nfunction f() {\n  return 1;\n}\n";
const tag = (n: number, text = SOURCE): string => formatLineTag(n, splitAnchoredLines(text).lines[n - 1]);
const apply = (edits: HashlineEdit[], text = SOURCE): string => applyHashlineEdits(text, edits).content;

describe("xxh32", () => {
  it("matches the reference test vectors", () => {
    expect(xxh32("").toString(16).padStart(8, "0")).toBe("02cc5d05");
    expect(xxh32("a").toString(16).padStart(8, "0")).toBe("550d7456");
    expect(xxh32("abc").toString(16).padStart(8, "0")).toBe("32d153ff");
    expect(xxh32("Nobody inspects the spammish repetition")).toBe(0xe2293b2f);
  });

  it("covers the 16-byte block path and non-ASCII input", () => {
    const long = "The quick brown fox jumps over the lazy dog";
    expect(xxh32(long)).toBe(0xe85ea4de);
    expect(xxh32("héllo wörld ✓")).toBe(xxh32(Buffer.from("héllo wörld ✓", "utf8")));
  });
});

describe("lineId / tags", () => {
  it("uses the consonant alphabet and is whitespace-insensitive", () => {
    expect(lineId("return 1;")).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
    expect(lineId("  return 1;")).toBe(lineId("return 1;"));
    expect(lineId("\treturn   1 ;\r")).toBe(lineId("return 1;"));
    expect(lineId("return 2;")).not.toBe(lineId("return 1;"));
  });

  it("renders LINE#ID:content rows", () => {
    expect(renderAnchoredLines("a\nb\n")).toBe(`${anchorLine(1, "a")}\n${anchorLine(2, "b")}`);
    expect(renderAnchoredLines("a\r\nb")).toBe(`${anchorLine(1, "a")}\n${anchorLine(2, "b")}`);
    expect(renderAnchoredLines("x\ny", 10)).toBe(`${anchorLine(10, "x")}\n${anchorLine(11, "y")}`);
    expect(renderAnchoredLines("")).toBe("");
    expect(anchorLine(4, "  return 1;")).toMatch(/^4#[ZPMQVRWSNKTXJBYH]{2}: {2}return 1;$/);
  });

  it("parses tags and tolerates copied decoration", () => {
    const id = lineId("x");
    expect(parseTag(`4#${id}`)).toEqual({ line: 4, hash: id });
    expect(parseTag(`4#${id}:  return 1;`)).toEqual({ line: 4, hash: id });
    expect(parseTag(`>>> 12#${id}:foo`)).toEqual({ line: 12, hash: id });
    expect(parseTag(` + 7 # ${id}`)).toEqual({ line: 7, hash: id });
  });

  it("rejects malformed tags with guidance", () => {
    expect(() => parseTag("4#aa")).toThrow(/Invalid line reference "4#aa"/);
    expect(() => parseTag("abc")).toThrow(/Expected format "LINE#ID"/);
    expect(() => parseTag("0#ZZ")).toThrow(/Line number must be >= 1/);
  });

  it("does not treat the empty string after a final newline as a line", () => {
    expect(splitAnchoredLines("a\nb\n")).toEqual({ lines: ["a", "b"], trailingNewline: true });
    expect(splitAnchoredLines("a\nb")).toEqual({ lines: ["a", "b"], trailingNewline: false });
    expect(splitAnchoredLines("")).toEqual({ lines: [], trailingNewline: true });
    expect(splitAnchoredLines("\n")).toEqual({ lines: [""], trailingNewline: true });
  });
});

describe("applyHashlineEdits", () => {
  it("replaces one line", () => {
    expect(apply([{ op: "replace", tag: tag(4), content: ["  return 2;"] }])).toBe(
      "import a from 'a';\n\nfunction f() {\n  return 2;\n}\n",
    );
  });

  it("combines range replace, append and prepend in one call using original numbering", () => {
    const result = apply([
      { op: "prepend", before: tag(1), content: ["// header"] },
      { op: "replace", first: tag(3), last: tag(5), content: ["const f = () => 3;"] },
      { op: "append", after: tag(5), content: ["export { f };"] },
    ]);
    expect(result).toBe("// header\nimport a from 'a';\n\nconst f = () => 3;\nexport { f };\n");
  });

  it("places an append after a range that ends on the same line (upstream ordering bug)", () => {
    const result = apply([
      { op: "replace", first: tag(4), last: tag(5), content: ["  return 3;", "}"] },
      { op: "append", after: tag(5), content: ["// tail"] },
    ]);
    expect(result).toBe("import a from 'a';\n\nfunction f() {\n  return 3;\n}\n// tail\n");
  });

  it("deletes a line or a range when content is omitted or empty", () => {
    expect(apply([{ op: "replace", tag: tag(2), content: null }])).toBe("import a from 'a';\nfunction f() {\n  return 1;\n}\n");
    expect(apply([{ op: "replace", first: tag(3), last: tag(5) }])).toBe("import a from 'a';\n\n");
    expect(apply([{ op: "replace", tag: tag(2), content: [] }])).toBe("import a from 'a';\nfunction f() {\n  return 1;\n}\n");
  });

  it("keeps a blank line when content is [\"\"]", () => {
    expect(apply([{ op: "replace", tag: tag(4), content: [""] }])).toBe("import a from 'a';\n\nfunction f() {\n\n}\n");
  });

  it("inserts between adjacent lines", () => {
    expect(apply([{ op: "insert", after: tag(1), before: tag(2), content: ["import b from 'b';"] }])).toBe(
      "import a from 'a';\nimport b from 'b';\n\nfunction f() {\n  return 1;\n}\n",
    );
  });

  it("appends at end of file keeping the trailing newline, and prepends at the start", () => {
    expect(apply([{ op: "append", content: ["export {};"] }])).toBe(`${SOURCE}export {};\n`);
    expect(apply([{ op: "prepend", content: ["// top"] }])).toBe(`// top\n${SOURCE}`);
  });

  it("respects a file without a trailing newline", () => {
    const text = "a\nb";
    expect(apply([{ op: "append", content: ["c"] }], text)).toBe("a\nb\nc");
    expect(apply([{ op: "replace", tag: tag(2, text), content: ["B"] }], text)).toBe("a\nB");
  });

  it("appends to an empty file", () => {
    expect(apply([{ op: "append", content: ["first"] }], "")).toBe("first\n");
  });

  it("keeps request order for several inserts at the same position", () => {
    const result = apply([
      { op: "append", after: tag(1), content: ["one"] },
      { op: "append", after: tag(1), content: ["two"] },
    ]);
    expect(result).toBe("import a from 'a';\none\ntwo\n\nfunction f() {\n  return 1;\n}\n");
  });

  it("puts a prepend before the replacement of the same line", () => {
    const result = apply([
      { op: "replace", tag: tag(4), content: ["  return 5;"] },
      { op: "prepend", before: tag(4), content: ["  // five"] },
    ]);
    expect(result).toBe("import a from 'a';\n\nfunction f() {\n  // five\n  return 5;\n}\n");
  });

  it("de-duplicates identical edits", () => {
    const edit: HashlineEdit = { op: "replace", tag: tag(4), content: ["  return 9;"] };
    expect(apply([edit, { ...edit }])).toBe("import a from 'a';\n\nfunction f() {\n  return 9;\n}\n");
  });

  it("rejects overlapping edits instead of corrupting the file", () => {
    expect(() =>
      apply([
        { op: "replace", first: tag(3), last: tag(5), content: ["x"] },
        { op: "replace", tag: tag(4), content: ["y"] },
      ]),
    ).toThrow(/overlap/);
    expect(() =>
      apply([
        { op: "replace", first: tag(3), last: tag(5), content: ["x"] },
        { op: "append", after: tag(4), content: ["y"] },
      ]),
    ).toThrow(/overlap/);
  });

  it("reports no-ops and leaves the content untouched", () => {
    const result = applyHashlineEdits(SOURCE, [{ op: "replace", tag: tag(4), content: ["  return 1;"] }]);
    expect(result.content).toBe(SOURCE);
    expect(result.noops).toEqual([{ editIndex: 0, location: tag(4), currentContent: "  return 1;" }]);
  });

  it("handles CR-terminated lines without treating CR as a change", () => {
    const text = "a\r\nb\r\n";
    const result = applyHashlineEdits(text, [{ op: "replace", tag: formatLineTag(1, "a"), content: ["a"] }]);
    expect(result.noops).toHaveLength(1);
  });
});

describe("validation", () => {
  it("rejects a stale tag with the current anchors and context", () => {
    const changed = SOURCE.replace("return 1;", "return 9;");
    let error: unknown;
    try {
      apply([{ op: "replace", tag: tag(4), content: ["x"] }], changed);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HashlineMismatchError);
    const message = (error as Error).message;
    expect(message).toContain("1 line has changed since last read. Use the updated LINE#ID references shown below (>>> marks changed lines).");
    expect(message).toContain(`>>> ${anchorLine(4, "  return 9;")}`);
    expect(message).toContain(`    ${anchorLine(3, "function f() {")}`);
    expect(message).toContain(`    ${anchorLine(5, "}")}`);
    expect(message).toContain("No edits were applied");
  });

  it("collects every stale tag before failing and does not mutate", () => {
    const changed = "x1\nx2\nx3\nx4\nx5\nx6\nx7\nx8\nx9\n";
    const stale = (n: number): string => `${n}#${lineId("other")}`;
    const run = (): string => apply([{ op: "replace", tag: stale(2), content: ["a"] }, { op: "replace", tag: stale(8), content: ["b"] }], changed);
    expect(run).toThrow(/2 lines have changed since last read/);
    expect(run).toThrow(/>>> 2#/);
    expect(run).toThrow(/>>> 8#/);
    expect(run).toThrow(/ {4}\.\.\./);
  });

  it("whitespace-only changes do not invalidate tags", () => {
    const reindented = SOURCE.replace("  return 1;", "      return 1;");
    expect(apply([{ op: "replace", tag: tag(4), content: ["  return 5;"] }], reindented)).toContain("return 5");
  });

  it("rejects out-of-range lines, bad ranges and bad inserts", () => {
    expect(() => apply([{ op: "replace", tag: `99#${lineId("x")}`, content: ["x"] }])).toThrow(/Line 99 does not exist \(file has 5 lines\)/);
    expect(() => apply([{ op: "replace", first: tag(5), last: tag(3), content: ["x"] }])).toThrow(/Range start line 5 must be <= end line 3/);
    expect(() => apply([{ op: "insert", after: tag(3), before: tag(3), content: ["x"] }])).toThrow(/insert requires after \(3\) < before \(3\)/);
    expect(() => apply([{ op: "append", content: [] }])).toThrow(/append requires non-empty content/);
    expect(() => apply([{ op: "prepend", content: [] }])).toThrow(/prepend requires non-empty content/);
    expect(() => apply([{ op: "insert", after: tag(1), before: tag(2), content: [] }])).toThrow(/insert requires non-empty content/);
  });

  it("does not mutate when any edit is invalid", () => {
    expect(() =>
      apply([
        { op: "replace", tag: tag(1), content: ["changed"] },
        { op: "replace", tag: `77#${lineId("x")}`, content: ["x"] },
      ]),
    ).toThrow(/does not exist/);
  });
});

describe("normalizeContent", () => {
  it("splits embedded newlines and drops carriage returns", () => {
    expect(normalizeContent(["a\nb", "c\r\nd"])).toEqual(["a", "b", "c", "d"]);
  });

  it("treats a trailing newline on elements as a line ending, not a blank line", () => {
    expect(normalizeContent(["a\n", "b\n"])).toEqual(["a", "b"]);
    expect(normalizeContent(["a\nb\n"])).toEqual(["a", "b"]);
    expect(normalizeContent(["a", ""])).toEqual(["a", ""]);
  });

  it("strips LINE#ID prefixes pasted from a read", () => {
    expect(normalizeContent([anchorLine(3, "  x();"), anchorLine(4, "}")])).toEqual(["  x();", "}"]);
    expect(normalizeContent([anchorLine(3, "  x();"), "plain"])).toEqual([anchorLine(3, "  x();"), "plain"]);
  });
});

describe("renderAnchoredRegions", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);

  it("shows context, merges overlapping windows and separates gaps", () => {
    const out = renderAnchoredRegions(lines, [[4, 5], [6, 7], [20, 21]], { context: 1 }).split("\n");
    expect(out[0]).toBe(anchorLine(4, "l4"));
    expect(out).toContain("...");
    expect(out.filter((row) => row === "...")).toHaveLength(1);
    expect(out.at(-1)).toBe(anchorLine(22, "l22"));
  });

  it("handles a pure deletion point and caps the output", () => {
    const point = renderAnchoredRegions(lines, [[10, 10]], { context: 2 }).split("\n");
    expect(point).toHaveLength(4);
    const capped = renderAnchoredRegions(lines, [[0, 30]], { maxLines: 5 }).split("\n");
    expect(capped).toHaveLength(6);
    expect(capped.at(-1)).toMatch(/25 more lines/);
  });
});
