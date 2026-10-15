import { describe, expect, it } from "vitest";
import { formatDuration, formatTokens, plural, sanitizeForDisplay } from "./fmt.js";

describe("formatDuration / formatTokens / plural", () => {
  it("formats durations compactly", () => {
    expect(formatDuration(40)).toBe("<0.1s");
    expect(formatDuration(900)).toBe("0.9s");
    expect(formatDuration(3200)).toBe("3.2s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(3_700_000)).toBe("1h 1m");
  });

  it("formats token counts", () => {
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(45_600)).toBe("46k");
  });

  it("pluralizes", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(3, "file")).toBe("3 files");
    expect(plural(2, "match", "matches")).toBe("2 matches");
  });
});

describe("sanitizeForDisplay", () => {
  it("strips colors, cursor movement and screen clears", () => {
    expect(sanitizeForDisplay("\u001b[31mred\u001b[0m \u001b[2J\u001b[Hgone \u001b[1;1H!")).toBe("red gone !");
  });

  it("strips OSC sequences (titles, hyperlinks, clipboard writes)", () => {
    expect(sanitizeForDisplay("a\u001b]0;pwned\u0007b\u001b]52;c;ZXZpbA==\u001b\\c")).toBe("abc");
  });

  it("collapses carriage-return progress output to the final state", () => {
    expect(sanitizeForDisplay("10%\r50%\r100%\ndone")).toBe("100%\ndone");
    expect(sanitizeForDisplay("line\r\nnext")).toBe("line\nnext");
  });

  it("removes other control characters but keeps tabs as spaces", () => {
    expect(sanitizeForDisplay("a\u0007b\u0000c\td")).toBe("abc  d");
  });
});
