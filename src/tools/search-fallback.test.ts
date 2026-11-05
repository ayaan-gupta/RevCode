import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { globFiles, globToRegExp } from "./glob.js";
import { grepFiles } from "./grep.js";

// Search must work on machines without ripgrep (it isn't installed by default on macOS).
const missing = "rg-not-installed-here";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "revcode-search-"));
  const files: Record<string, string> = {
    "src/app.ts": "export const answer = 42;\n",
    "src/util/strings.js": "// TODO: answer later\n",
    "README.md": "The answer is in src.\n",
    "node_modules/dep/index.js": "answer\n",
    "ignored.log": "answer\n",
    ".gitignore": "*.log\n",
  };
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
});

describe("without ripgrep", () => {
  it("grep falls back to grep -r and skips dependency folders", async () => {
    const result = await grepFiles({ pattern: "answer" }, { cwd: dir, rg: missing });
    const lines = result.matches.split("\n").sort();
    expect(lines).toContain("src/app.ts:1:export const answer = 42;");
    expect(lines).toContain("README.md:1:The answer is in src.");
    expect(result.matches).not.toContain("node_modules");
    expect((await grepFiles({ pattern: "answer", glob: "*.ts" }, { cwd: dir, rg: missing })).matches).toBe("src/app.ts:1:export const answer = 42;");
    expect(await grepFiles({ pattern: "nowhere" }, { cwd: dir, rg: missing })).toEqual({ matches: "(no matches)", exitCode: 1 });
  });

  it("glob falls back to git's file list and matches like ripgrep", async () => {
    expect((await globFiles({ pattern: "*.ts" }, { cwd: dir, rg: missing })).matches).toEqual(["src/app.ts"]);
    expect((await globFiles({ pattern: "src/**/*.js" }, { cwd: dir, rg: missing })).matches).toEqual(["src/util/strings.js"]);
    expect((await globFiles({ pattern: "**/*.{ts,js}" }, { cwd: dir, rg: missing })).matches.sort()).toEqual(["src/app.ts", "src/util/strings.js"]);
    expect((await globFiles({ pattern: "*.ts", path: "src" }, { cwd: dir, rg: missing })).matches).toEqual(["src/app.ts"]);
    expect((await globFiles({ pattern: "*.log" }, { cwd: dir, rg: missing })).content).toContain("no files matched");
  });

  it("translates globs", () => {
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("file?.[jt]s").test("file1.ts")).toBe(true);
    expect(globToRegExp("a.{md,txt}").test("a.txt")).toBe(true);
    expect(globToRegExp("a+b.txt").test("a+b.txt")).toBe(true);
  });
});
