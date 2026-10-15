import { describe, expect, it } from "vitest";
import { clip, graphemes, graphemeWidth, indexAtWidth, padEnd, stripAnsi, truncate, visibleWidth, wrapAnsi } from "./width.js";

const ESC = "\u001b";
const bold = (t: string): string => `${ESC}[1m${t}${ESC}[0m`;
const red = (t: string): string => `${ESC}[31m${t}${ESC}[0m`;

describe("visibleWidth", () => {
  it("counts ASCII as one cell each", () => {
    expect(visibleWidth("hello")).toBe(5);
    expect(visibleWidth("")).toBe(0);
  });

  it("ignores ANSI styling and OSC hyperlinks", () => {
    expect(visibleWidth(bold("hi"))).toBe(2);
    expect(visibleWidth(`${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe(4);
  });

  it("counts CJK and emoji as two cells", () => {
    expect(visibleWidth("日本語")).toBe(6);
    expect(visibleWidth("🚀")).toBe(2);
    expect(visibleWidth("a🚀b")).toBe(4);
  });

  it("treats combining marks as zero width and keeps clusters together", () => {
    expect(visibleWidth("é")).toBe(1);
    expect(graphemes("éx")).toEqual(["é", "x"]);
  });

  it("measures ZWJ sequences, skin tones, flags and VS16 as one wide glyph", () => {
    expect(graphemeWidth("👨‍👩‍👧")).toBe(2);
    expect(graphemeWidth("👍🏽")).toBe(2);
    expect(graphemeWidth("🇯🇵")).toBe(2);
    expect(graphemeWidth("❤️")).toBe(2);
  });

  it("keeps box-drawing and common symbols narrow", () => {
    expect(visibleWidth("─│╭╮⠋●›❯…")).toBe(9);
  });
});

describe("stripAnsi", () => {
  it("removes SGR and OSC sequences", () => {
    expect(stripAnsi(`${bold("a")}${red("b")}c`)).toBe("abc");
  });
});

describe("truncate / clip", () => {
  it("leaves short text alone", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });

  it("adds an ellipsis within the width", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcd…");
    expect(visibleWidth(truncate("abcdefgh", 5))).toBe(5);
  });

  it("does not split wide characters", () => {
    const out = truncate("日本語日本語", 5);
    expect(visibleWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith("…")).toBe(true);
  });

  it("closes open styles when cutting", () => {
    const out = truncate(bold("abcdefgh"), 4);
    expect(out).toContain(`${ESC}[0m…`);
    expect(visibleWidth(out)).toBe(4);
  });

  it("clip cuts without an ellipsis", () => {
    expect(clip("abcdef", 3)).toBe("abc");
    expect(clip(red("abcdef"), 3)).toBe(`${ESC}[31mabc${ESC}[0m`);
  });
});

describe("wrapAnsi", () => {
  it("wraps at word boundaries", () => {
    expect(wrapAnsi("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });

  it("keeps existing newlines", () => {
    expect(wrapAnsi("a\nb", 10)).toEqual(["a", "b"]);
  });

  it("breaks words longer than the width", () => {
    expect(wrapAnsi("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("applies a hanging indent to continuation rows", () => {
    expect(wrapAnsi("one two three four", 9, { indent: "  " })).toEqual(["one two", "  three", "  four"]);
  });

  it("never exceeds the width, even with wide characters", () => {
    for (const row of wrapAnsi("日本語のテキストを折り返す 日本語のテキスト", 12)) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(12);
    }
  });

  it("closes and reopens styles across wrapped rows", () => {
    const rows = wrapAnsi(bold("alpha beta gamma delta"), 11);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith(`${ESC}[1m`)).toBe(true);
      expect(row.endsWith(`${ESC}[0m`)).toBe(true);
    }
    expect(rows.map(stripAnsi).join(" ")).toBe("alpha beta gamma delta");
  });

  it("does not lose a style change that follows a space", () => {
    const rows = wrapAnsi(`aaaa bbbb ${red("cccc")} dddd`, 9);
    expect(rows.join("")).toContain(`${ESC}[31mcccc`);
  });

  it("preserves leading indentation on the first row", () => {
    expect(wrapAnsi("  indented words here", 12)[0]).toBe("  indented");
  });
});

describe("indexAtWidth / padEnd", () => {
  it("finds the cut index by cells", () => {
    expect(indexAtWidth("abcdef", 3)).toBe(3);
    expect(indexAtWidth("日本語", 4)).toBe(2);
    expect(indexAtWidth("日本語", 3)).toBe(1);
  });

  it("pads by visible width", () => {
    expect(padEnd(bold("ab"), 4)).toBe(`${bold("ab")}  `);
  });
});

describe("hyperlinks across wraps", () => {
  const link = (url: string, text: string): string => `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;

  it("closes an open hyperlink at the end of a row and reopens it on the next", () => {
    const rows = wrapAnsi(`see ${link("https://x.test", "the quick brown fox jumps")} now`, 14);
    expect(rows.length).toBeGreaterThan(1);
    const open = `${ESC}]8;;https://x.test${ESC}\\`;
    const close = `${ESC}]8;;${ESC}\\`;
    for (const row of rows.slice(0, -1)) {
      const opens = row.split(open).length - 1;
      const closes = row.split(close).length - 1;
      expect(opens).toBe(closes); // every row is balanced on its own
    }
    expect(rows.map(stripAnsi).join(" ")).toBe("see the quick brown fox jumps now");
  });

  it("truncate closes an open hyperlink", () => {
    const out = truncate(link("https://x.test", "abcdefghij"), 5);
    expect(out).toContain(`${ESC}]8;;${ESC}\\`);
    expect(visibleWidth(out)).toBe(5);
  });
});
