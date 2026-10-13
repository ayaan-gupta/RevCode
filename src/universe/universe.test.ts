import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyLand, planLand, resolveInside, summarizePlan } from "./land.js";
import { Universe } from "./universe.js";

let previousHome: string | undefined;
let project: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function makeGitProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-proj-"));
  git(dir, "init", "-q", "-b", "main");
  write(path.join(dir, "src/a.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  write(path.join(dir, "README.md"), "# demo\n");
  write(path.join(dir, ".gitignore"), "dist/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  write(path.join(dir, "dist/out.js"), "ignored build output");
  write(path.join(dir, "untracked.txt"), "not yet committed");
  write(path.join(dir, "node_modules/dep/index.js"), "module.exports = 1;");
  return dir;
}

beforeEach(() => {
  previousHome = process.env.REVCODE_HOME;
  process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  project = makeGitProject();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.REVCODE_HOME;
  else process.env.REVCODE_HOME = previousHome;
});

describe("Universe.create", () => {
  it("copies tracked and untracked files, skips ignored output, links node_modules", async () => {
    const u = await Universe.create({ projectRoot: project });
    expect(readFileSync(path.join(u.workDir, "src/a.ts"), "utf8")).toContain("export const a");
    expect(existsSync(path.join(u.workDir, "untracked.txt"))).toBe(true);
    expect(existsSync(path.join(u.workDir, "dist/out.js"))).toBe(false);
    expect(lstatSync(path.join(u.workDir, "node_modules")).isSymbolicLink()).toBe(true);
    expect(u.meta.linked).toEqual(["node_modules"]);
    expect(u.checkpoints()).toHaveLength(1);
    expect(u.checkpoints()[0].kind).toBe("base");
    expect(u.meta.baseSha).toBe(u.checkpoints()[0].sha);
  });

  it("works for a plain (non-git) directory and honors default excludes", async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), "revcode-plain-"));
    write(path.join(plain, "app.py"), "print(1)\n");
    write(path.join(plain, "__pycache__/x.pyc"), "bytes");
    write(path.join(plain, "sub/b.txt"), "b");
    const u = await Universe.create({ projectRoot: plain });
    expect(existsSync(path.join(u.workDir, "app.py"))).toBe(true);
    expect(existsSync(path.join(u.workDir, "sub/b.txt"))).toBe(true);
    expect(existsSync(path.join(u.workDir, "__pycache__"))).toBe(false);
  });

  it("refuses a filesystem root or home directory", async () => {
    await expect(Universe.create({ projectRoot: "/" })).rejects.toThrow(/Refusing/);
    await expect(Universe.create({ projectRoot: os.homedir() })).rejects.toThrow(/Refusing/);
  });

  it("can be reopened and listed", async () => {
    const u = await Universe.create({ projectRoot: project, model: "glm-5.2" });
    expect(Universe.open(u.id).meta.model).toBe("glm-5.2");
    expect(Universe.list().map((m) => m.id)).toContain(u.id);
    expect(Universe.list({ projectRoot: "/elsewhere" })).toEqual([]);
  });
});

describe("checkpoints, rewind, fork", () => {
  it("records whether each checkpoint changed the tree", async () => {
    const u = await Universe.create({ projectRoot: project });
    const noop = await u.checkpoint({ kind: "tool", tool: "shell", summary: "ls" });
    expect(noop.changed).toBe(false);

    write(path.join(u.workDir, "new.txt"), "hello");
    const changed = await u.checkpoint({ kind: "tool", tool: "write_file", summary: "new.txt" });
    expect(changed.changed).toBe(true);
    expect(changed.sha).not.toBe(noop.sha);
    expect(u.checkpoints().map((c) => c.n)).toEqual([1, 2, 3]);
  });

  it("rewinds files (including removing new ones) and the rewind is undoable", async () => {
    const u = await Universe.create({ projectRoot: project });
    write(path.join(u.workDir, "src/a.ts"), "changed\n");
    const cp = await u.checkpoint({ kind: "tool", tool: "edit_file", summary: "edit a.ts", messageCount: 4 });
    write(path.join(u.workDir, "later.txt"), "later");
    write(path.join(u.workDir, "src/a.ts"), "changed again\n");

    const rewound = await u.rewind(1);
    expect(readFileSync(path.join(u.workDir, "src/a.ts"), "utf8")).toContain("export const a = 1");
    expect(existsSync(path.join(u.workDir, "later.txt"))).toBe(false);
    expect(rewound.kind).toBe("rewind");

    // Undo the rewind by going back to the pre-rewind state checkpoint.
    const preRewind = u.checkpoints().find((c) => c.summary.startsWith("state before rewind"));
    expect(preRewind).toBeDefined();
    await u.rewind(preRewind!.n);
    expect(readFileSync(path.join(u.workDir, "src/a.ts"), "utf8")).toBe("changed again\n");
    expect(existsSync(path.join(u.workDir, "later.txt"))).toBe(true);
    expect(cp.messageCount).toBe(4);
  });

  it("rejects unknown checkpoints", async () => {
    const u = await Universe.create({ projectRoot: project });
    await expect(u.rewind(99)).rejects.toThrow(/No checkpoint/);
  });

  it("forks an independent sibling at a checkpoint", async () => {
    const u = await Universe.create({ projectRoot: project });
    write(path.join(u.workDir, "one.txt"), "1");
    const cp = await u.checkpoint({ kind: "tool", tool: "write_file", summary: "one" });
    write(path.join(u.workDir, "two.txt"), "2");
    await u.checkpoint({ kind: "tool", tool: "write_file", summary: "two" });

    const child = await u.fork(cp.n);
    expect(child.meta.parentId).toBe(u.id);
    expect(child.meta.baseSha).toBe(u.meta.baseSha);
    expect(existsSync(path.join(child.workDir, "one.txt"))).toBe(true);
    expect(existsSync(path.join(child.workDir, "two.txt"))).toBe(false);
    expect(lstatSync(path.join(child.workDir, "node_modules")).isSymbolicLink()).toBe(true);

    write(path.join(child.workDir, "child-only.txt"), "c");
    await child.checkpoint({ kind: "tool", tool: "write_file", summary: "child" });
    expect(existsSync(path.join(u.workDir, "child-only.txt"))).toBe(false);
    expect(child.checkpoints().at(-1)?.summary).toBe("child");
    expect((await child.changedFiles()).sort()).toEqual(["child-only.txt", "one.txt"]);
  });

  it("carries only the lineage up to the fork point into the child's timeline", async () => {
    const u = await Universe.create({ projectRoot: project });
    u.recordPrompt(1, "first task");
    write(path.join(u.workDir, "one.txt"), "1");
    const cp = await u.checkpoint({ kind: "tool", tool: "write_file", summary: "one" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    u.recordPrompt(2, "second task");
    write(path.join(u.workDir, "two.txt"), "2");
    await u.checkpoint({ kind: "tool", tool: "write_file", summary: "two" });

    const child = await u.fork(cp.n);
    expect(child.prompts().map((p) => p.text)).toEqual(["first task"]);
    expect(child.checkpoints().map((c) => c.summary)).not.toContain("two");
  });

  it("reports diff stats against the base", async () => {
    const u = await Universe.create({ projectRoot: project });
    write(path.join(u.workDir, "src/a.ts"), "export const a = 1;\nexport const b = 20;\nexport const c = 3;\nexport const d = 4;\n");
    const stat = await u.diffStat();
    expect(stat).toEqual({ files: 1, insertions: 2, deletions: 1 });
    expect(await u.diff()).toContain("+export const d = 4;");
  });

  it("discard removes the working copy but keeps the record", async () => {
    const u = await Universe.create({ projectRoot: project });
    u.discard();
    expect(existsSync(u.workDir)).toBe(false);
    expect(existsSync(path.join(u.dir, "meta.json"))).toBe(true);
    expect(Universe.list()).toHaveLength(0);
    expect(Universe.list({ includeDiscarded: true })).toHaveLength(1);
  });
});

describe("landing", () => {
  it("lands adds, edits, and deletes onto an untouched project", async () => {
    const u = await Universe.create({ projectRoot: project });
    write(path.join(u.workDir, "src/a.ts"), "export const a = 100;\nexport const b = 2;\nexport const c = 3;\n");
    write(path.join(u.workDir, "src/new/file.ts"), "export {};\n");
    execFileSync("rm", [path.join(u.workDir, "README.md")]);

    const plan = await planLand(u);
    expect(plan.items.map((i) => `${i.status}:${i.path}:${i.action}`).sort()).toEqual([
      "A:src/new/file.ts:write",
      "D:README.md:delete",
      "M:src/a.ts:write",
    ]);
    expect(summarizePlan(plan)).toContain("2 to write");

    const result = await applyLand(u, plan);
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(path.join(project, "src/a.ts"), "utf8")).toContain("a = 100");
    expect(existsSync(path.join(project, "src/new/file.ts"))).toBe(true);
    expect(existsSync(path.join(project, "README.md"))).toBe(false);
    // Untouched files stay put.
    expect(readFileSync(path.join(project, "untracked.txt"), "utf8")).toBe("not yet committed");

    // After a clean land the merge base moves forward: nothing left to land.
    expect((await planLand(u)).items).toEqual([]);
  });

  it("auto-merges independent edits made in the project meanwhile", async () => {
    const u = await Universe.create({ projectRoot: project });
    write(
      path.join(u.workDir, "src/a.ts"),
      "export const a = 100;\nexport const b = 2;\nexport const c = 3;\n",
    );
    // The user edits a different line of the real project while the agent works.
    write(path.join(project, "src/a.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 300;\n");

    const plan = await planLand(u);
    expect(plan.items[0]).toMatchObject({ action: "write", merged: true });
    await applyLand(u, plan);
    expect(readFileSync(path.join(project, "src/a.ts"), "utf8")).toBe(
      "export const a = 100;\nexport const b = 2;\nexport const c = 300;\n",
    );
  });

  it("reports overlapping edits as conflicts and never overwrites by default", async () => {
    const u = await Universe.create({ projectRoot: project });
    write(path.join(u.workDir, "src/a.ts"), "export const a = 100;\nexport const b = 2;\nexport const c = 3;\n");
    write(path.join(project, "src/a.ts"), "export const a = 999;\nexport const b = 2;\nexport const c = 3;\n");

    const plan = await planLand(u);
    expect(plan.items[0].action).toBe("conflict");

    const skipped = await applyLand(u, plan);
    expect(skipped.conflicts).toEqual(["src/a.ts"]);
    expect(readFileSync(path.join(project, "src/a.ts"), "utf8")).toContain("a = 999");
    // Conflicts keep the merge base where it was so they stay visible.
    expect((await planLand(u)).items).toHaveLength(1);

    const marked = await applyLand(u, await planLand(u), { onConflict: "markers" });
    expect(marked.conflicts).toEqual(["src/a.ts"]);
    expect(readFileSync(path.join(project, "src/a.ts"), "utf8")).toContain("<<<<<<< project");

    write(path.join(project, "src/a.ts"), "export const a = 999;\nexport const b = 2;\nexport const c = 3;\n");
    const theirs = await applyLand(u, await planLand(u), { onConflict: "theirs" });
    expect(theirs.written).toEqual(["src/a.ts"]);
    expect(readFileSync(path.join(project, "src/a.ts"), "utf8")).toContain("a = 100");
  });

  it("flags edit-vs-delete conflicts and files that already exist", async () => {
    const u = await Universe.create({ projectRoot: project });
    write(path.join(u.workDir, "README.md"), "# changed in universe\n");
    write(path.join(u.workDir, "added.txt"), "universe version");
    execFileSync("rm", [path.join(project, "README.md")]);
    write(path.join(project, "added.txt"), "project version");

    const plan = await planLand(u);
    const byPath = Object.fromEntries(plan.items.map((i) => [i.path, i]));
    expect(byPath["README.md"].action).toBe("conflict");
    expect(byPath["README.md"].detail).toContain("deleted in the project");
    expect(byPath["added.txt"].action).toBe("conflict");
  });

  it("preserves the executable bit", async () => {
    const u = await Universe.create({ projectRoot: project });
    write(path.join(u.workDir, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(path.join(u.workDir, "run.sh"), 0o755);
    await applyLand(u, await planLand(u));
    expect(statSync(path.join(project, "run.sh")).mode & 0o111).not.toBe(0);
  });

  it("lands only selected paths and keeps the rest pending", async () => {
    const u = await Universe.create({ projectRoot: project });
    write(path.join(u.workDir, "x.txt"), "x");
    write(path.join(u.workDir, "y.txt"), "y");
    const plan = await planLand(u, { paths: ["x.txt"] });
    expect(plan.items.map((i) => i.path)).toEqual(["x.txt"]);
    await applyLand(u, plan);
    expect(existsSync(path.join(project, "x.txt"))).toBe(true);
    expect(existsSync(path.join(project, "y.txt"))).toBe(false);
    const pending = (await planLand(u)).items.filter((i) => i.action !== "identical");
    expect(pending.map((i) => i.path)).toEqual(["y.txt"]);
  });

  it("lands symlinks as symlinks", async () => {
    const u = await Universe.create({ projectRoot: project });
    symlinkSync("src/a.ts", path.join(u.workDir, "link.ts"));
    await applyLand(u, await planLand(u));
    expect(lstatSync(path.join(project, "link.ts")).isSymbolicLink()).toBe(true);
  });

  it("never writes outside the project root", () => {
    expect(() => resolveInside(project, "../escape.txt")).toThrow(/outside the project/);
    expect(() => resolveInside(project, "/etc/passwd")).toThrow();
    const outside = mkdtempSync(path.join(os.tmpdir(), "revcode-outside-"));
    symlinkSync(outside, path.join(project, "sneaky"));
    expect(() => resolveInside(project, "sneaky/file.txt")).toThrow(/symlink/);
  });
});
