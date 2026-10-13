import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadInstructions } from "./instructions.js";

describe("loadInstructions", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.REVCODE_HOME;
    process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
    root = mkdtempSync(path.join(os.tmpdir(), "revcode-repo-"));
    mkdirSync(path.join(root, ".git"));
    mkdirSync(path.join(root, "pkg", "sub"), { recursive: true });
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.REVCODE_HOME;
    else process.env.REVCODE_HOME = previousHome;
  });

  it("layers repo-root and nested files outermost first", () => {
    writeFileSync(path.join(root, "AGENTS.md"), "root rules");
    writeFileSync(path.join(root, "pkg", "AGENTS.md"), "pkg rules");
    const { text, files } = loadInstructions(path.join(root, "pkg", "sub"));
    expect(files).toHaveLength(2);
    expect(text.indexOf("root rules")).toBeLessThan(text.indexOf("pkg rules"));
  });

  it("prefers AGENTS.md over CLAUDE.md in the same directory, but adds REVCODE.md", () => {
    writeFileSync(path.join(root, "AGENTS.md"), "agents");
    writeFileSync(path.join(root, "CLAUDE.md"), "claude");
    writeFileSync(path.join(root, "REVCODE.md"), "revcode");
    const { text } = loadInstructions(root);
    expect(text).toContain("agents");
    expect(text).not.toContain("claude");
    expect(text).toContain("revcode");
  });

  it("falls back to CLAUDE.md and includes the global file", () => {
    writeFileSync(path.join(root, "CLAUDE.md"), "claude rules");
    writeFileSync(path.join(process.env.REVCODE_HOME as string, "AGENTS.md"), "global rules");
    const { text } = loadInstructions(root);
    expect(text).toContain("claude rules");
    expect(text.indexOf("global rules")).toBeLessThan(text.indexOf("claude rules"));
  });

  it("ignores ancestors when there is no git root", () => {
    const loose = mkdtempSync(path.join(os.tmpdir(), "revcode-loose-"));
    mkdirSync(path.join(loose, "inner"));
    writeFileSync(path.join(loose, "AGENTS.md"), "outer");
    expect(loadInstructions(path.join(loose, "inner")).text).toBe("");
  });

  it("returns empty text when nothing exists", () => {
    expect(loadInstructions(root)).toEqual({ text: "", files: [] });
  });
});
