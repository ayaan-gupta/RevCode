import { describe, expect, it } from "vitest";
import {
  diffLineBlocks,
  diffStat,
  findClosestLines,
  generateDiff,
  levenshtein,
  similarity,
  splitDiffLines,
} from "./diff.js";

/** Minimal unified-diff applier (no fuzz): the round-trip oracle for generateDiff. */
function applyUnified(original: string, diff: string): string {
  const lines = splitDiffLines(original).lines;
  const out: string[] = [];
  let cursor = 0;
  let newHasNoEol = false;
  let previous = "";
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
    if (header) {
      const target = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1;
      while (cursor < target) out.push(lines[cursor++]);
    } else if (line.startsWith("\\")) {
      // The marker describes the new file only after '+' or context lines.
      if (previous === "+" || previous === " ") newHasNoEol = true;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      out.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      expect(lines[cursor]).toBe(line.slice(1));
      cursor += 1;
    } else if (line.startsWith(" ")) {
      expect(lines[cursor]).toBe(line.slice(1));
      out.push(lines[cursor++]);
    }
    previous = line[0] ?? "";
  }
  while (cursor < lines.length) out.push(lines[cursor++]);
  return out.length === 0 ? "" : out.join("\n") + (newHasNoEol ? "" : "\n");
}

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function roundTrip(before: string, after: string): string {
  const diff = generateDiff(before, after, "f.txt");
  expect(applyUnified(before, diff)).toBe(lf(after));
  return diff;
}

const numbered = (count: number, from = 1): string =>
  Array.from({ length: count }, (_, i) => `line ${from + i}`).join("\n") + "\n";

describe("generateDiff", () => {
  it("returns an empty string for identical content", () => {
    expect(generateDiff("a\nb\n", "a\nb\n", "f.txt")).toBe("");
  });

  it("emits headers and a hunk with 3 lines of context", () => {
    const before = numbered(20);
    const after = before.replace("line 10\n", "line TEN\n");
    const diff = generateDiff(before, after, "src/a.ts");
    expect(diff.split("\n")).toEqual([
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -7,7 +7,7 @@",
      " line 7",
      " line 8",
      " line 9",
      "-line 10",
      "+line TEN",
      " line 11",
      " line 12",
      " line 13",
    ]);
  });

  it("keeps a one-line edit to a 2,000-line file tiny", () => {
    const before = numbered(2_000);
    const after = before.replace("line 1000\n", "line 1000 edited\n");
    const diff = generateDiff(before, after, "big.txt");
    expect(diff.split("\n").length).toBeLessThan(15);
    expect(applyUnified(before, diff)).toBe(after);
  });

  it("merges nearby changes into one hunk and splits distant ones", () => {
    const before = numbered(40);
    const near = before.replace("line 10\n", "A\n").replace("line 14\n", "B\n");
    expect(generateDiff(before, near, "f").match(/^@@/gm)).toHaveLength(1);
    const far = before.replace("line 5\n", "A\n").replace("line 30\n", "B\n");
    const diff = generateDiff(before, far, "f");
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(applyUnified(before, diff)).toBe(far);
  });

  it("treats a gap of exactly 2*context lines as one hunk, 2*context+1 as two", () => {
    const before = numbered(30);
    const six = before.replace("line 5\n", "A\n").replace("line 12\n", "B\n");
    expect(generateDiff(before, six, "f").match(/^@@/gm)).toHaveLength(1);
    const seven = before.replace("line 5\n", "A\n").replace("line 13\n", "B\n");
    expect(generateDiff(before, seven, "f").match(/^@@/gm)).toHaveLength(2);
    roundTrip(before, six);
    roundTrip(before, seven);
  });

  it("handles insertions and deletions at the start and end of a file", () => {
    const before = numbered(10);
    roundTrip(before, `top\n${before}`);
    roundTrip(before, `${before}bottom\n`);
    roundTrip(before, before.replace("line 1\n", ""));
    roundTrip(before, before.replace("line 10\n", ""));
  });

  it("describes creating a file from empty content", () => {
    const diff = generateDiff("", "one\ntwo\n", "new.txt");
    expect(diff).toBe("--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two");
    expect(applyUnified("", diff)).toBe("one\ntwo\n");
  });

  it("describes emptying a file", () => {
    const diff = generateDiff("one\ntwo\n", "", "gone.txt");
    expect(diff).toBe("--- a/gone.txt\n+++ b/gone.txt\n@@ -1,2 +0,0 @@\n-one\n-two");
    expect(applyUnified("one\ntwo\n", diff)).toBe("");
  });

  it("marks a missing trailing newline on either side", () => {
    const noEol = generateDiff("a\nb", "a\nB", "f");
    expect(noEol).toContain("-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file");

    const added = roundTrip("a\nb", "a\nb\n");
    expect(added).toContain("-b\n\\ No newline at end of file\n+b");
    const removed = roundTrip("a\nb\n", "a\nb");
    expect(removed).toContain("-b\n+b\n\\ No newline at end of file");
  });

  it("round-trips an edit above an unterminated last line", () => {
    roundTrip("a\nb\nc", "A\nb\nc");
    roundTrip("a\nb\nc", "a\nb\nc\nd");
  });

  it("ignores carriage returns when comparing and never prints them", () => {
    const before = "a\r\nb\r\nc\r\n";
    const after = "a\r\nB\r\nc\r\n";
    const diff = generateDiff(before, after, "f");
    expect(diff).not.toContain("\r");
    expect(diff).toContain("-b\n+B");
    expect(applyUnified(before, diff)).toBe("a\nB\nc\n");
  });

  it("reports line-ending-only changes explicitly", () => {
    const diff = generateDiff("a\r\nb\r\n", "a\nb\n", "f");
    expect(diff).toContain("(no textual changes; line endings changed from CRLF to LF)");
  });

  it("handles blank lines, repeated lines and whitespace-only changes", () => {
    roundTrip("a\n\n\nb\n\n", "a\n\nb\n\n\n");
    roundTrip("x\nx\nx\nx\n", "x\nx\nx\n");
    roundTrip("if (a) {\n  b();\n}\n", "if (a) {\n\tb();\n}\n");
  });

  it("round-trips pseudo-random edits", () => {
    let seed = 1234;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 60; round += 1) {
      const before = Array.from({ length: Math.floor(random() * 40) }, () => `v${Math.floor(random() * 8)}`);
      const after = before.slice();
      for (let edit = 0; edit < Math.floor(random() * 6); edit += 1) {
        const at = Math.floor(random() * (after.length + 1));
        if (random() < 0.5) after.splice(at, Math.floor(random() * 3), `n${Math.floor(random() * 5)}`);
        else after.splice(at, 1);
      }
      const finish = (lines: string[]): string => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);
      roundTrip(finish(before), finish(after));
    }
  });

  it("elides the middle of a huge diff and says how much was omitted", () => {
    const before = numbered(3_000);
    const after = numbered(3_000, 5_000);
    const diff = generateDiff(before, after, "huge.txt");
    const lines = diff.split("\n");
    expect(lines.length).toBeLessThan(450);
    expect(diff).toMatch(/\[\.\.\. \d+ diff lines omitted/);
    expect(lines[2]).toMatch(/^@@/);
  });

  it("keeps the first and last hunks when eliding many hunks", () => {
    const before = numbered(2_000);
    let after = before;
    for (let n = 50; n <= 1_950; n += 25) after = after.replace(`line ${n}\n`, `CHANGED ${n}\n`);
    const diff = generateDiff(before, after, "f");
    expect(diff).toContain("CHANGED 50");
    expect(diff).toContain("CHANGED 1950");
    expect(diff).toMatch(/omitted across \d+ hunks/);
  });

  it("clips very long rows in the output", () => {
    const long = "x".repeat(1_000_000);
    const diff = generateDiff(`${long}\n`, `${long}y\n`, "min.js");
    expect(diff.length).toBeLessThan(2_000);
    expect(diff).toContain("-" + "x".repeat(500) + "… [999500 more characters]");
    expect(diff).toContain("[999501 more characters]");
  });

  it("honors a custom context size and line cap", () => {
    const before = numbered(30);
    const after = before.replace("line 15\n", "X\n");
    const wide = generateDiff(before, after, "f", { context: 5 });
    expect(wide).toContain("@@ -10,11 +10,11 @@");
    const none = generateDiff(before, after, "f", { context: 0 });
    expect(none.split("\n")).toEqual(["--- a/f", "+++ b/f", "@@ -15,1 +15,1 @@", "-line 15", "+X"]);
  });

  it("falls back to one replacement block for unrelated huge inputs", () => {
    const a = Array.from({ length: 4_000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 4_000 }, (_, i) => `b${i}`);
    const blocks = diffLineBlocks(a, b);
    expect(blocks).toEqual([{ oldStart: 0, oldEnd: 4_000, newStart: 0, newEnd: 4_000 }]);
  });

  it("is fast on large files with a small edit", () => {
    const before = numbered(200_000);
    const after = before.replace("line 100000\n", "changed\nextra\n");
    const started = Date.now();
    const diff = generateDiff(before, after, "f");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(diff).toContain("+changed\n+extra");
  });
});

describe("diffLineBlocks / diffStat", () => {
  it("returns minimal blocks for a swap in the middle", () => {
    expect(diffLineBlocks(["a", "b", "c", "d"], ["a", "x", "c", "d"])).toEqual([
      { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 },
    ]);
  });

  it("finds the shortest script when lines move", () => {
    const blocks = diffLineBlocks(["a", "b", "c", "d", "e"], ["b", "c", "d", "e", "a"]);
    const changed = blocks.reduce((sum, b) => sum + (b.oldEnd - b.oldStart) + (b.newEnd - b.newStart), 0);
    expect(changed).toBe(2);
  });

  it("counts added and removed lines", () => {
    expect(diffStat("a\nb\nc\n", "a\nB\nB2\nc\nd\n")).toEqual({ added: 3, removed: 1 });
    expect(diffStat("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
  });
});

describe("similarity helpers", () => {
  it("computes edit distance and ratio", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("", "")).toBe(1);
    expect(similarity("abcd", "abcf")).toBeCloseTo(0.75);
  });

  it("stays cheap on very long strings", () => {
    const a = "x".repeat(50_000);
    const b = `${"x".repeat(49_000)}y${"x".repeat(1_000)}`;
    const started = Date.now();
    expect(similarity(a, b)).toBeGreaterThan(0.9);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("findClosestLines", () => {
  const file = [
    "import os",
    "",
    "def compute_total(items):",
    "    total = 0",
    "    for item in items:",
    "        total += item.price",
    "    return total",
  ];

  it("locates the closest window and the first differing line", () => {
    const match = findClosestLines(file, ["def compute_total(items):", "    total = 1", "    for item in items:"]);
    expect(match).not.toBeNull();
    expect(match!.line).toBe(3);
    expect(match!.score).toBeGreaterThan(0.8);
    expect(match!.expected).toBe("    total = 1");
    expect(match!.actual).toBe("    total = 0");
  });

  it("shows indentation mistakes as the differing line", () => {
    const match = findClosestLines(file, ["total = 0", "for item in items:"]);
    expect(match!.line).toBe(4);
    expect(match!.expected).toBe("total = 0");
    expect(match!.actual).toBe("    total = 0");
  });

  it("returns null for empty input", () => {
    expect(findClosestLines([], ["x"])).toBeNull();
    expect(findClosestLines(file, ["", " "])).toBeNull();
  });

  it("handles a large haystack quickly", () => {
    const hay = Array.from({ length: 20_000 }, (_, i) => `    value_${i} = compute(${i}, "text ${i}")`);
    const started = Date.now();
    const match = findClosestLines(hay, ["    value_9999 = compute(9999, \"text 9998\")", "    value_10000 = compute(10000)"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(match!.line).toBeGreaterThan(9_990);
    expect(match!.line).toBeLessThan(10_010);
  });
});
