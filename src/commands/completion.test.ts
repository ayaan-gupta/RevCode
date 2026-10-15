import { describe, expect, it } from "vitest";
import { completionScript } from "./completion.js";

describe("completionScript", () => {
  it("generates bash, zsh and fish scripts that know the real flags and subcommands", () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      const script = completionScript(shell) as string;
      expect(script).toContain("revcode");
      expect(script).toContain("universes");
      expect(script).toMatch(/--universe|-l universe|universe\[/);
    }
  });

  it("completes values for enumerated flags", () => {
    const bash = completionScript("bash") as string;
    expect(bash).toContain("--provider) COMPREPLY=($(compgen -W \"zai anthropic");
    expect(bash).toContain("accept-edits");
    expect(bash).toContain("--theme)");
  });

  it("returns undefined for an unknown shell", () => {
    expect(completionScript("powershell")).toBeUndefined();
  });
});
