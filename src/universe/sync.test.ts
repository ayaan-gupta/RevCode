import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planLand, applyLand } from "./land.js";
import { syncFromProject } from "./sync.js";
import { Universe } from "./universe.js";

let previousHome: string | undefined;
let project: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
const read = (dir: string, file: string): string => readFileSync(path.join(dir, file), "utf8");
const lines = (n: number, label = "line"): string => Array.from({ length: n }, (_, i) => `${label} ${i + 1}`).join("\n") + "\n";

beforeEach(() => {
  previousHome = process.env.REVCODE_HOME;
  process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  project = mkdtempSync(path.join(os.tmpdir(), "revcode-sync-"));
  git(project, "init", "-q");
  writeFileSync(path.join(project, "mine.txt"), "mine v1\n");
  writeFileSync(path.join(project, "shared.txt"), lines(20));
  writeFileSync(path.join(project, "gone.txt"), "delete me\n");
  writeFileSync(path.join(project, ".gitignore"), "build/\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "start");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.REVCODE_HOME;
  else process.env.REVCODE_HOME = previousHome;
});

describe("syncFromProject", () => {
  it("brings your edits into the copy without counting them as the agent's", async () => {
    const u = await Universe.create({ projectRoot: project });
    // The agent edits the end of shared.txt in the copy.
    writeFileSync(path.join(u.workDir, "shared.txt"), lines(20).replace("line 20", "line 20 (agent)"));
    // Meanwhile you edit, add and delete files in your editor.
    writeFileSync(path.join(project, "mine.txt"), "mine v2\n");
    writeFileSync(path.join(project, "shared.txt"), lines(20).replace("line 1\n", "line 1 (you)\n"));
    writeFileSync(path.join(project, "added.txt"), "new\n");
    unlinkSync(path.join(project, "gone.txt"));

    const result = await syncFromProject(u);
    expect(result.pulled.sort()).toEqual(["added.txt", "gone.txt", "mine.txt"]);
    expect(result.merged).toEqual(["shared.txt"]);
    expect(result.conflicts).toEqual([]);
    expect(read(u.workDir, "mine.txt")).toBe("mine v2\n");
    expect(read(u.workDir, "added.txt")).toBe("new\n");
    expect(existsSync(path.join(u.workDir, "gone.txt"))).toBe(false);
    expect(read(u.workDir, "shared.txt")).toContain("line 1 (you)");
    expect(read(u.workDir, "shared.txt")).toContain("line 20 (agent)");

    // Only the agent's work is a change; landing applies exactly that.
    expect(await u.changedFiles()).toEqual(["shared.txt"]);
    const plan = await planLand(u);
    const result2 = await applyLand(u, plan);
    expect(result2.conflicts).toEqual([]);
    expect(read(project, "shared.txt")).toContain("line 1 (you)");
    expect(read(project, "shared.txt")).toContain("line 20 (agent)");

    // Nothing new: a second sync does nothing.
    expect(await syncFromProject(u)).toEqual({ pulled: [], merged: [], conflicts: [] });
  });

  it("a rewind to before your edits never makes landing undo them", async () => {
    const u = await Universe.create({ projectRoot: project });
    writeFileSync(path.join(project, "mine.txt"), "mine v2\n");
    await syncFromProject(u);
    writeFileSync(path.join(u.workDir, "agent.txt"), "agent\n");
    await u.checkpoint({ kind: "tool", tool: "write_file", summary: "agent.txt" });

    await u.rewind(1); // back to the very start: mine.txt is v1 in the copy again
    expect(read(u.workDir, "mine.txt")).toBe("mine v1\n");
    expect(await u.changedFiles()).toEqual([]); // not "mine.txt changed back to v1"

    const plan = await planLand(u);
    expect(plan.items).toEqual([]);
    expect(read(project, "mine.txt")).toBe("mine v2\n");

    // The next sync brings your edit in again.
    expect((await syncFromProject(u)).pulled).toEqual(["mine.txt"]);
    expect(read(u.workDir, "mine.txt")).toBe("mine v2\n");
  });

  it("leaves overlapping edits alone and reports them", async () => {
    const u = await Universe.create({ projectRoot: project });
    writeFileSync(path.join(u.workDir, "shared.txt"), lines(20).replace("line 5", "line 5 (agent)"));
    writeFileSync(path.join(project, "shared.txt"), lines(20).replace("line 5", "line 5 (you)"));
    const result = await syncFromProject(u);
    expect(result.conflicts).toEqual(["shared.txt"]);
    expect(read(u.workDir, "shared.txt")).toContain("line 5 (agent)");
    // The same conflict is reported again next time (callers show new ones only).
    expect((await syncFromProject(u)).conflicts).toEqual(["shared.txt"]);
  });

  it("ignores ignored files and keeps tracked-but-ignored ones", async () => {
    writeFileSync(path.join(project, ".gitignore"), "build/\n*.secret\n");
    writeFileSync(path.join(project, "keep.secret"), "tracked anyway\n");
    git(project, "add", "-f", "keep.secret", ".gitignore");
    git(project, "commit", "-qm", "secret");
    const u = await Universe.create({ projectRoot: project });
    execFileSync("mkdir", ["-p", path.join(project, "build")]);
    writeFileSync(path.join(project, "build", "out.js"), "generated\n");
    const result = await syncFromProject(u);
    expect(result).toEqual({ pulled: [], merged: [], conflicts: [] });
    expect(existsSync(path.join(u.workDir, "keep.secret"))).toBe(true);
    expect(existsSync(path.join(u.workDir, "build"))).toBe(false);
  });

  it("follows your commits in the copy's git history", async () => {
    const u = await Universe.create({ projectRoot: project });
    expect(git(u.workDir, "log", "--format=%s")).toBe("start");
    writeFileSync(path.join(project, "mine.txt"), "mine v3\n");
    git(project, "commit", "-qam", "second");
    await syncFromProject(u);
    expect(git(u.workDir, "log", "--format=%s")).toBe("second\nstart");
    expect(git(u.workDir, "status", "--porcelain")).toBe(git(project, "status", "--porcelain"));
    expect(read(u.workDir, "mine.txt")).toBe("mine v3\n");
  });
});
