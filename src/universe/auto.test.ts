import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultArgs, resolveArgs, type CliArgs } from "../cli.js";
import { createRuntime } from "../agent/setup.js";
import { say, ScriptedLlm } from "../testing/scripted-llm.js";
import { autoUniverse } from "./auto.js";
import { Universe } from "./universe.js";

let previousHome: string | undefined;
let project: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();

function gitProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-auto-"));
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "app.js"), "console.log(1)\n");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  git(dir, "remote", "add", "origin", "https://example.com/acme/app.git");
  mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(dir, "app.js"), "console.log(2)\n"); // uncommitted change
  writeFileSync(path.join(dir, "staged.txt"), "staged\n");
  git(dir, "add", "staged.txt");
  return dir;
}

beforeEach(() => {
  previousHome = process.env.REVCODE_HOME;
  process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  project = gitProject();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.REVCODE_HOME;
  else process.env.REVCODE_HOME = previousHome;
});

describe("autoUniverse", () => {
  it("copies a git project, with a git repository that mirrors the real one", async () => {
    const realRefs = git(project, "for-each-ref");
    const realIndex = readFileSync(path.join(project, ".git", "index"));
    const { universe, skipped } = await autoUniverse(project);
    expect(skipped).toBeUndefined();
    const work = universe!.workDir;
    expect(universe!.meta.projectGit).toBe(true);

    // Same history, branch, staged/unstaged state and remotes as the project.
    expect(git(work, "log", "--format=%s")).toBe("first");
    expect(git(work, "branch", "--show-current")).toBe(git(project, "branch", "--show-current"));
    expect(git(work, "status", "--porcelain")).toBe(git(project, "status", "--porcelain"));
    expect(git(work, "remote", "get-url", "origin")).toBe("https://example.com/acme/app.git");

    // Commits in the copy stay in the copy.
    writeFileSync(path.join(work, "new.txt"), "x\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "in the copy");
    expect(git(project, "for-each-ref")).toBe(realRefs);
    expect(readFileSync(path.join(project, ".git", "index")).equals(realIndex)).toBe(true);
    expect(existsSync(path.join(project, "new.txt"))).toBe(false);

    // The copy's .git is never part of what lands.
    expect(await universe!.changedFiles()).toEqual(["new.txt"]);

    // A fork (used by rewinds, races and replays) gets its own mirror too.
    const fork = await universe!.fork(1);
    expect(git(fork.workDir, "log", "--format=%s")).toBe("first");
    expect(git(fork.workDir, "status", "--porcelain")).toBe(git(project, "status", "--porcelain"));
  });

  it("works directly in folders that aren't git projects, are too big, or use submodules", async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), "revcode-plain-"));
    writeFileSync(path.join(plain, "a.txt"), "a\n");
    expect(await autoUniverse(plain)).toEqual({ skipped: "it isn't a git repository" });

    expect(await autoUniverse(project, { limits: { maxFiles: 1 } })).toEqual({ skipped: "it's too big to copy quickly" });

    const sub = gitProject();
    git(sub, "update-index", "--add", "--cacheinfo", `160000,${git(project, "rev-parse", "HEAD")},vendor/lib`);
    expect(await autoUniverse(sub)).toEqual({ skipped: "it uses git submodules" });
    expect(Universe.list()).toHaveLength(0);
  });

  it("refuses the home folder", async () => {
    const before = process.env.HOME;
    process.env.HOME = project;
    try {
      expect(await autoUniverse(project)).toEqual({ skipped: "this is your home folder, not a project" });
    } finally {
      process.env.HOME = before;
    }
  });
});

describe("interactive sessions copy by default", () => {
  const args = (overrides: Partial<CliArgs> = {}): CliArgs => ({
    ...resolveArgs({ ...defaultArgs(), cwd: project }, { config: {}, warnings: [], files: [] }, {}),
    snapshot: false,
    mcp: false,
    hooks: false,
    ...overrides,
  });

  it("works in a copy without asking, but asks before reaching outside it", async () => {
    const rt = await createRuntime({ args: args(), interactive: true, autoUniverse: true, llm: new ScriptedLlm([say("hi")]) });
    try {
      expect(rt.universe).toBeDefined();
      expect(rt.cwd).toBe(rt.universe!.workDir);
      expect(rt.permissions.getMode()).toBe("yolo");
      expect(rt.engine.messages[0].content).toContain("its own git repository");
      expect(rt.permissions.evaluate("shell", { command: "npm test" }).action).toBe("allow");
      expect(rt.permissions.evaluate("shell", { command: "git push origin HEAD" })).toMatchObject({ action: "ask", outside: true });
      expect(rt.permissions.evaluate("shell", { command: `cat ${project}/app.js` })).toMatchObject({ action: "ask", outside: true });
    } finally {
      await rt.dispose();
    }
  });

  it("respects --no-universe and explains a fallback", async () => {
    const off = await createRuntime({ args: args({ universe: false }), interactive: true, autoUniverse: true, llm: new ScriptedLlm([say("hi")]) });
    expect(off.universe).toBeUndefined();
    expect(off.universeSkipped).toBeUndefined();
    expect(off.permissions.getMode()).toBe("ask");
    await off.dispose();

    const plain = mkdtempSync(path.join(os.tmpdir(), "revcode-plain-"));
    const direct = await createRuntime({ args: args({ cwd: plain }), interactive: true, autoUniverse: true, llm: new ScriptedLlm([say("hi")]) });
    expect(direct.universe).toBeUndefined();
    expect(direct.universeSkipped).toBe("it isn't a git repository");
    expect(direct.permissions.getMode()).toBe("ask");
    await direct.dispose();
  });

  it("leaves headless runs in the project unless asked", async () => {
    const rt = await createRuntime({ args: args({ headless: true }), interactive: false, llm: new ScriptedLlm([say("hi")]) });
    expect(rt.universe).toBeUndefined();
    await rt.dispose();
  });
});
