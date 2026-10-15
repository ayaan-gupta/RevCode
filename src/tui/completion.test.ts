import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCompleter, FileIndex, fuzzyScore, rankByFuzzy } from "./completion.js";

describe("fuzzyScore", () => {
  it("ranks basename prefixes above path prefixes above substrings above subsequences", () => {
    const names = ["docs/readme.md", "src/read.ts", "src/tui/render.ts", "src/other/thread.ts"];
    const ranked = rankByFuzzy("read", names, (n) => n);
    expect(ranked[0]).toBe("src/read.ts");
    expect(ranked).toContain("src/other/thread.ts");
  });

  it("matches subsequences and is case-insensitive", () => {
    expect(fuzzyScore("stui", "src/tui/ui.ts")).toBeGreaterThan(0);
    expect(fuzzyScore("README", "docs/readme.md")).toBeGreaterThan(0);
    expect(fuzzyScore("zzz", "src/tui/ui.ts")).toBe(-1);
  });

  it("scores an empty query as a match for everything", () => {
    expect(fuzzyScore("", "anything")).toBeGreaterThan(0);
  });
});

describe("FileIndex", () => {
  it("lists tracked and untracked files but not ignored ones, via git", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-idx-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "a.ts"), "");
    writeFileSync(path.join(dir, "b.ts"), "");
    writeFileSync(path.join(dir, "ignored.log"), "");
    writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
    const index = new FileIndex(dir);
    await index.load();
    const entries = index.entries();
    expect(entries).toContain("src/a.ts");
    expect(entries).toContain("b.ts");
    expect(entries).toContain("src/");
    expect(entries).not.toContain("ignored.log");
  });

  it("falls back to walking the directory outside a repository, skipping junk directories", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-walk-"));
    mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    mkdirSync(path.join(dir, "lib"));
    writeFileSync(path.join(dir, "node_modules", "x", "i.js"), "");
    writeFileSync(path.join(dir, "lib", "m.py"), "");
    const index = new FileIndex(dir);
    await index.load();
    expect(index.entries()).toContain("lib/m.py");
    expect(index.entries().some((e) => e.includes("node_modules"))).toBe(false);
  });

  it("is not ready until loaded, and the completer kicks off the load", () => {
    const index = new FileIndex("/definitely/not/here");
    const complete = createCompleter({ commands: () => [], files: index });
    expect(index.ready).toBe(false);
    expect(complete("@sr", 3)).toBeUndefined();
  });
});

describe("createCompleter", () => {
  const commands = [
    { command: "/compact", description: "Free up context" },
    { command: "/context", description: "Show context" },
    { command: "/clear", description: "Clear" },
  ];
  const complete = createCompleter({ commands: () => commands });

  it("lists everything for a bare slash and filters by prefix", () => {
    expect(complete("/", 1)?.items).toHaveLength(3);
    expect(complete("/co", 3)?.items.map((i) => i.insert)).toEqual(["/compact", "/context"]);
  });

  it("falls back to fuzzy matching when nothing has the prefix", () => {
    expect(complete("/cmpct", 6)?.items.map((i) => i.insert)).toEqual(["/compact"]);
  });

  it("does not complete in the middle of normal prose", () => {
    expect(complete("hello /co", 9)).toBeUndefined();
    expect(complete("", 0)).toBeUndefined();
  });

  it("stops offering the command once its arguments start (unless it has values)", () => {
    expect(complete("/compact now", 12)).toBeUndefined();
  });

  it("finds @mentions only at the start of a word", () => {
    const index = new FileIndex("/x");
    index.setFiles(["src/a.ts"]);
    const c = createCompleter({ commands: () => [], files: index });
    expect(c("see @src", 8)?.items.map((i) => i.insert)).toEqual(["@src/", "@src/a.ts"]);
    expect(c("mail me@src", 11)).toBeUndefined();
    expect(c("see @src", 8)).toMatchObject({ start: 4, end: 8 });
  });
});
