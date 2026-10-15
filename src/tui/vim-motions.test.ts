import { describe, expect, it } from "vitest";
import { findChar, firstNonBlank, lineEndOf, lineStartOf, wordBackward, wordEnd, wordForward, type Cell } from "./vim-motions.js";

const cells = (text: string): Cell[] => Array.from(text).map((ch, i) => ({ text: ch, start: i, end: i + 1 }));

describe("word motions", () => {
  const text = "foo bar.baz  qux";
  const c = cells(text);

  it("w moves to the start of the next word, treating punctuation as its own word", () => {
    expect(wordForward(c, 0, 1)).toBe(4);
    expect(wordForward(c, 4, 1)).toBe(7);
    expect(wordForward(c, 7, 1)).toBe(8);
    expect(wordForward(c, 8, 1)).toBe(13);
    expect(wordForward(c, 0, 3)).toBe(8);
  });

  it("W skips whole blank-delimited words", () => {
    expect(wordForward(c, 4, 1, true)).toBe(13);
  });

  it("b moves back to the start of a word", () => {
    expect(wordBackward(c, 13, 1)).toBe(8);
    expect(wordBackward(c, 8, 1)).toBe(7);
    expect(wordBackward(c, 6, 1)).toBe(4);
    expect(wordBackward(c, 13, 3)).toBe(4);
  });

  it("e moves to the end of the word", () => {
    expect(wordEnd(c, 0, 1)).toBe(2);
    expect(wordEnd(c, 2, 1)).toBe(6);
    expect(wordEnd(c, 4, 2)).toBe(7);
  });

  it("stays put at the ends", () => {
    expect(wordForward(c, 13, 5)).toBe(16);
    expect(wordBackward(c, 0, 3)).toBe(0);
  });
});

describe("line and find motions", () => {
  const text = "  one two\nthree four";
  it("finds line starts, ends and the first non-blank", () => {
    expect(lineStartOf(text, 14)).toBe(10);
    expect(lineEndOf(text, 3)).toBe(9);
    expect(firstNonBlank(text, 5)).toBe(2);
  });

  it("f/F/t/T find characters on the current line only", () => {
    expect(findChar(text, 0, "t", "f", 1)).toBe(6);
    expect(findChar(text, 0, "t", "t", 1)).toBe(5);
    expect(findChar(text, 8, "o", "F", 1)).toBe(2);
    expect(findChar(text, 8, "e", "F", 1)).toBe(4);
    expect(findChar(text, 0, "x", "f", 1)).toBeUndefined();
    expect(findChar(text, 0, "r", "f", 1)).toBeUndefined(); // "three" is on the next line
  });
});
