import { describe, expect, it } from "vitest";
import { generateDiff } from "../utils/diff.js";
import { parseUnifiedDiff, renderDiffView } from "./diff-view.js";
import { plainStyle, Style } from "./style.js";
import { stripAnsi, visibleWidth } from "./width.js";

const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const after = before.replace("line 5\n", "LINE five\n").replace("line 25\n", "line 25\nextra\n");
const diff = generateDiff(before, after, "src/x.ts");

describe("parseUnifiedDiff", () => {
  it("counts additions and removals and tracks line numbers", () => {
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.added).toBe(2);
    expect(parsed.removed).toBe(1);
    const del = parsed.rows.find((r) => r.kind === "del");
    expect(del).toMatchObject({ oldNo: 5, text: "line 5" });
    const add = parsed.rows.find((r) => r.kind === "add" && r.text === "extra");
    expect(add).toMatchObject({ newNo: 26 });
  });

  it("handles a brand-new file", () => {
    const parsed = parseUnifiedDiff(generateDiff("", "a\nb\n", "new.txt"));
    expect(parsed).toMatchObject({ added: 2, removed: 0 });
    expect(parsed.rows.filter((r) => r.kind === "add").map((r) => r.newNo)).toEqual([1, 2]);
  });
});

describe("renderDiffView", () => {
  it("shows a gutter with line numbers, +/- markers and separates hunks", () => {
    const view = renderDiffView(diff, { style: plainStyle(), width: 60, maxRows: 100 });
    expect(view.added).toBe(2);
    expect(view.removed).toBe(1);
    expect(view.rows.some((r) => /^\s+5 - line 5/.test(r))).toBe(true);
    expect(view.rows.some((r) => /^\s+5 \+ LINE five/.test(r))).toBe(true);
    expect(view.rows.some((r) => r.trim() === "…")).toBe(true);
  });

  it("limits the number of rows and says how many were hidden", () => {
    const view = renderDiffView(diff, { style: plainStyle(), width: 60, maxRows: 6 });
    expect(view.rows).toHaveLength(6);
    expect(view.hidden).toBeGreaterThan(0);
    expect(view.rows.at(-1)).toMatch(/more lines$/);
  });

  it("shades added and removed lines when color is available", () => {
    const style = new Style({ colorDepth: 24, theme: "dark", unicode: true, hyperlinks: false });
    const view = renderDiffView(diff, { style, width: 60, maxRows: 100 });
    expect(view.rows.some((r) => r.includes("48;2;") && stripAnsi(r).includes("LINE five"))).toBe(true);
  });

  it("never exceeds the width, even for very long lines", () => {
    const long = generateDiff("x\n", `${"y".repeat(400)}\n`, "a.txt");
    for (const row of renderDiffView(long, { style: plainStyle(), width: 50, maxRows: 20 }).rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(50);
    }
  });

  it("strips escape sequences smuggled into diff content", () => {
    const evil = generateDiff("a\n", "b\u001b]0;title\u0007\u001b[2J\n", "f.txt");
    const rows = renderDiffView(evil, { style: plainStyle(), width: 50, maxRows: 20 }).rows.join("\n");
    expect(rows).not.toContain("\u001b");
  });

  it("names each file when a patch touches several", () => {
    const multi = `${generateDiff("a\n", "b\n", "one.ts")}\n${generateDiff("c\n", "d\n", "two.ts")}`;
    const rows = renderDiffView(multi, { style: plainStyle(), width: 50, maxRows: 20 }).rows;
    expect(rows).toContain("one.ts");
    expect(rows).toContain("two.ts");
  });
});
