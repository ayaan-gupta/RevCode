import { describe, expect, it } from "vitest";
import { getBannerLines, getBannerWidth, renderBanner } from "./banner.js";
import { stripAnsi } from "./ansi.js";

describe("banner", () => {
  it("renders non-empty lines", () => {
    const lines = getBannerLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps consistent line widths", () => {
    const lines = getBannerLines();
    const width = getBannerWidth();
    expect(width).toBeGreaterThan(20);
    for (const line of lines) {
      expect(line.length).toBe(width);
    }
  });

  it("includes REVCODE figlet art", () => {
    const text = getBannerLines().join("\n");
    expect(text).toMatch(/█/);
    expect(text).toMatch(/╗/);
    expect(getBannerLines().length).toBeGreaterThanOrEqual(5);
  });

  it("applies gradient without changing visible text", () => {
    const plain = getBannerLines();
    const rich = renderBanner(true).map(stripAnsi);
    expect(rich).toEqual(plain);
  });
});
