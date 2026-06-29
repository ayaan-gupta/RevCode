import { afterEach, describe, expect, it } from "vitest";
import { applyHorizontalGradient, stripAnsi, supportsColor } from "./ansi.js";
import { GRADIENT_END, GRADIENT_MID, GRADIENT_START } from "./theme.js";

describe("supportsColor", () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }

    if (originalForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = originalForceColor;
    }
  });

  it("returns false when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    expect(supportsColor(true)).toBe(false);
  });

  it("returns true when FORCE_COLOR is set", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(supportsColor(false)).toBe(true);
  });

  it("falls back to tty when color env vars are unset", () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    expect(supportsColor(true)).toBe(true);
    expect(supportsColor(false)).toBe(false);
  });
});

describe("applyHorizontalGradient", () => {
  it("returns plain text when rich mode is disabled", () => {
    const line = "██ REV ██";
    expect(applyHorizontalGradient(line, GRADIENT_START, GRADIENT_MID, GRADIENT_END, false)).toBe(
      line,
    );
  });

  it("adds truecolor escape codes to non-space characters", () => {
    const line = "ABC";
    const colored = applyHorizontalGradient(line, GRADIENT_START, GRADIENT_MID, GRADIENT_END, true);
    expect(colored).toContain("\u001b[38;2;");
    expect(stripAnsi(colored)).toBe(line);
  });

  it("preserves spaces without coloring them", () => {
    const line = "A B";
    const colored = applyHorizontalGradient(line, GRADIENT_START, GRADIENT_MID, GRADIENT_END, true);
    expect(stripAnsi(colored)).toBe(line);
    expect(colored.indexOf(" ")).toBeGreaterThan(-1);
  });
});
