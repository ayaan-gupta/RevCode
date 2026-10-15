import { describe, expect, it } from "vitest";
import { copyToClipboard, osc52Sequence } from "./clipboard.js";

describe("clipboard", () => {
  it("builds an OSC 52 sequence with base64 text", () => {
    expect(osc52Sequence("hello")).toBe(`\u001b]52;c;${Buffer.from("hello").toString("base64")}\u0007`);
  });

  it("caps the OSC 52 payload", () => {
    const seq = osc52Sequence("x".repeat(500_000));
    expect(seq.length).toBeLessThan(140_000);
  });

  it("falls back to OSC 52 when no native tool exists", async () => {
    // A platform with no candidates for this environment: an unknown platform and no Wayland.
    const result = await copyToClipboard("x", { PATH: "/nonexistent" }, "linux");
    expect(result).toBe("osc52");
  });
});
