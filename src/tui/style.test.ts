import { describe, expect, it } from "vitest";
import { detectCaps, detectColorDepth, detectHyperlinks, detectTheme, detectUnicode, plainStyle, rgbTo16, rgbTo256, Style } from "./style.js";
import { stripAnsi } from "./width.js";

describe("detectColorDepth", () => {
  it("is off for NO_COLOR, non-TTYs and dumb terminals", () => {
    expect(detectColorDepth({ NO_COLOR: "1", COLORTERM: "truecolor" }, true)).toBe(0);
    expect(detectColorDepth({ TERM: "xterm-256color" }, false)).toBe(0);
    expect(detectColorDepth({ TERM: "dumb" }, true)).toBe(0);
  });

  it("detects truecolor, 256 and 16 colors", () => {
    expect(detectColorDepth({ COLORTERM: "truecolor", TERM: "xterm-256color" }, true)).toBe(24);
    expect(detectColorDepth({ TERM: "xterm-256color" }, true)).toBe(8);
    expect(detectColorDepth({ TERM: "xterm" }, true)).toBe(4);
    expect(detectColorDepth({ TERM: "linux" }, true)).toBe(4);
  });

  it("treats macOS Terminal.app as 256-color (it has no truecolor)", () => {
    expect(detectColorDepth({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }, true)).toBe(8);
  });

  it("recognises modern terminals", () => {
    expect(detectColorDepth({ TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" }, true)).toBe(24);
    expect(detectColorDepth({ WT_SESSION: "x" }, true)).toBe(24);
    expect(detectColorDepth({ TERM: "xterm-kitty" }, true)).toBe(24);
  });

  it("honours FORCE_COLOR levels even when piped", () => {
    expect(detectColorDepth({ FORCE_COLOR: "1" }, false)).toBe(4);
    expect(detectColorDepth({ FORCE_COLOR: "2" }, false)).toBe(8);
    expect(detectColorDepth({ FORCE_COLOR: "3" }, false)).toBe(24);
    expect(detectColorDepth({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, true)).toBe(0);
  });
});

describe("detectTheme / unicode / hyperlinks", () => {
  it("reads COLORFGBG and explicit overrides", () => {
    expect(detectTheme({ COLORFGBG: "0;15" })).toBe("light");
    expect(detectTheme({ COLORFGBG: "15;0" })).toBe("dark");
    expect(detectTheme({ COLORFGBG: "15;default;0" })).toBe("dark");
    expect(detectTheme({}, "light")).toBe("light");
    expect(detectTheme({ REVCODE_THEME: "light", COLORFGBG: "15;0" })).toBe("light");
    expect(detectTheme({})).toBe("dark");
  });

  it("falls back to ASCII glyphs on the Linux console", () => {
    expect(detectUnicode({ TERM: "linux" })).toBe(false);
    expect(detectUnicode({ TERM: "xterm-256color" })).toBe(true);
    expect(detectUnicode({ REVCODE_ASCII: "1", TERM: "xterm" })).toBe(false);
  });

  it("enables hyperlinks only where they are known to work", () => {
    expect(detectHyperlinks({ TERM_PROGRAM: "iTerm.app" }, true)).toBe(true);
    expect(detectHyperlinks({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(false);
    expect(detectHyperlinks({ TERM_PROGRAM: "iTerm.app" }, false)).toBe(false);
    expect(detectHyperlinks({ REVCODE_HYPERLINKS: "1" }, false)).toBe(true);
  });
});

describe("color conversion", () => {
  it("maps pure colors into the 256 cube and gray ramp", () => {
    expect(rgbTo256([255, 0, 0])).toBe(196);
    expect(rgbTo256([0, 0, 0])).toBe(16);
    expect(rgbTo256([128, 128, 128])).toBeGreaterThanOrEqual(232);
  });

  it("maps to the nearest of the 16 ANSI colors", () => {
    expect(rgbTo16([255, 100, 100])).toBe(9);
    expect(rgbTo16([10, 10, 10])).toBe(0);
  });
});

describe("Style", () => {
  const caps = (colorDepth: 0 | 4 | 8 | 24) => ({ colorDepth, theme: "dark" as const, unicode: true, hyperlinks: false });

  it("emits nothing at depth 0", () => {
    const st = plainStyle();
    expect(st.paint("accent", "x")).toBe("x");
    expect(st.bold("x")).toBe("x");
    expect(st.gradient("hello")).toBe("hello");
  });

  it("downgrades truecolor roles to 256 and 16 colors", () => {
    expect(new Style(caps(24)).paint("accent", "x")).toContain("38;2;56;189;248");
    expect(new Style(caps(8)).paint("accent", "x")).toMatch(/38;5;\d+/);
    expect(new Style(caps(4)).paint("accent", "x")).toMatch(/\u001b\[(3|9)\dm/);
  });

  it("closes with targeted off codes so styles nest", () => {
    const st = new Style(caps(24));
    const nested = st.paint("accent", `a ${st.bold("b")} c`);
    expect(nested).toContain("\u001b[22m");
    expect(nested.endsWith("\u001b[39m")).toBe(true);
    expect(stripAnsi(nested)).toBe("a b c");
  });

  it("uses a different palette for light themes", () => {
    const dark = new Style({ ...caps(24), theme: "dark" }).paint("ok", "x");
    const light = new Style({ ...caps(24), theme: "light" }).paint("ok", "x");
    expect(dark).not.toBe(light);
  });

  it("skips subtle background shading on 16-color terminals", () => {
    expect(new Style(caps(4)).onBg("add", "x")).toBe("x");
    expect(new Style(caps(24)).onBg("add", "x")).toContain("48;2;");
  });

  it("switches to ASCII glyphs when unicode is off", () => {
    const st = new Style({ ...caps(0), unicode: false });
    expect(st.glyphs.prompt).toBe(">");
    expect(st.glyphs.spinner).toEqual(["|", "/", "-", "\\"]);
  });

  it("wraps hyperlinks in OSC 8 only when supported", () => {
    expect(new Style(caps(24)).link("https://x.test", "x")).toBe("x");
    const st = new Style({ ...caps(24), hyperlinks: true });
    expect(st.link("https://x.test", "x")).toBe("\u001b]8;;https://x.test\u001b\\x\u001b]8;;\u001b\\");
  });

  it("detectCaps assembles everything", () => {
    expect(detectCaps({ COLORTERM: "truecolor", COLORFGBG: "0;15" }, true)).toMatchObject({ colorDepth: 24, theme: "light", unicode: true });
  });
});
