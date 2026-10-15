import { describe, expect, it } from "vitest";
import { indexAtColumn, layoutRows, locate } from "./layout.js";

const slices = (text: string, width: number): string[] => layoutRows(text, width).map((r) => text.slice(r.start, r.end));

describe("layoutRows", () => {
  it("returns one empty row for empty text", () => {
    expect(layoutRows("", 10)).toEqual([{ start: 0, end: 0, continuation: false }]);
  });

  it("splits on newlines", () => {
    expect(slices("a\nb\n\nc", 10)).toEqual(["a", "b", "", "c"]);
  });

  it("wraps after spaces when it can", () => {
    expect(slices("hello wonderful world", 12)).toEqual(["hello ", "wonderful ", "world"]);
  });

  it("hard-wraps words longer than the row", () => {
    expect(slices("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("measures wide characters in cells", () => {
    expect(slices("日本語日本語", 6)).toEqual(["日本語", "日本語"]);
  });

  it("marks soft-wrapped rows as continuations", () => {
    expect(layoutRows("abcdefgh", 4).map((r) => r.continuation)).toEqual([false, true]);
    expect(layoutRows("ab\ncd", 4).map((r) => r.continuation)).toEqual([false, false]);
  });

  it("covers every character exactly once (no loss, no overlap)", () => {
    const text = "one two three four five six seven\neight nine ten";
    for (const width of [5, 8, 13, 40]) {
      const rows = layoutRows(text, width);
      let rebuilt = "";
      rows.forEach((row, i) => {
        rebuilt += text.slice(row.start, row.end);
        const next = rows[i + 1];
        if (next && !next.continuation) rebuilt += "\n";
      });
      expect(rebuilt).toBe(text);
    }
  });
});

describe("locate / indexAtColumn", () => {
  const text = "hello wonderful world";
  const rows = layoutRows(text, 12);

  it("finds the row and column of a cursor", () => {
    expect(locate(rows, text, 0)).toEqual({ row: 0, col: 0 });
    expect(locate(rows, text, 3)).toEqual({ row: 0, col: 3 });
    expect(locate(rows, text, 8)).toEqual({ row: 1, col: 2 });
    expect(locate(rows, text, text.length)).toEqual({ row: 2, col: 5 });
  });

  it("puts a cursor at a soft-wrap boundary at the start of the next row", () => {
    expect(locate(rows, text, 6)).toEqual({ row: 1, col: 0 });
  });

  it("keeps a cursor before a hard newline on its own row", () => {
    const t = "ab\ncd";
    const r = layoutRows(t, 10);
    expect(locate(r, t, 2)).toEqual({ row: 0, col: 2 });
    expect(locate(r, t, 3)).toEqual({ row: 1, col: 0 });
  });

  it("maps a column back to an index, clamped to the row", () => {
    expect(indexAtColumn(rows, text, 1, 3)).toBe(9);
    expect(indexAtColumn(rows, text, 2, 99)).toBe(text.length);
    expect(indexAtColumn(rows, text, 0, 99)).toBe(5); // before the wrap-trailing space
  });
});
