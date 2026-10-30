/**
 * Keep a universe's copy up to date with edits made in the real project
 * (in an editor, by another tool) while the session runs.
 *
 * Called at the start of each interactive turn, so the agent always sees your
 * latest files:
 *   - a file only you changed is brought into the copy;
 *   - a file you both changed is merged into the copy when the edits don't overlap;
 *   - overlapping edits are left alone and reported (landing sorts them out later).
 * Files brought in become part of the copy's starting point, so they never show
 * up as the agent's changes or get "landed" back.
 *
 * The project is read through the shadow repo with a separate index that caches
 * file stats, so after the first turn only files that changed are re-read. The
 * project and its `.git` are never written.
 */

import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LIMITS } from "./copy.js";
import { runShadowGit } from "./git.js";
import { isText, readReal, removeFile, resolveInside, threeWayMerge, writeItem } from "./land.js";
import { refreshProjectGit } from "./project-git.js";
import type { Universe } from "./universe.js";

export interface SyncResult {
  /** Files you changed that the copy now has too. */
  pulled: string[];
  /** Files you both changed, merged into the copy. */
  merged: string[];
  /** Files you both changed in overlapping ways: the copy keeps its version. */
  conflicts: string[];
}

interface RawEntry {
  path: string;
  status: string;
  newMode: string;
  oldSha: string;
  newSha: string;
}

const ZERO = /^0+$/;

export async function syncFromProject(universe: Universe): Promise<SyncResult> {
  const result: SyncResult = { pulled: [], merged: [], conflicts: [] };
  if (universe.meta.status !== "active" || !existsSync(universe.workDir)) return result;
  const projectRoot = universe.meta.projectRoot;
  if (!existsSync(projectRoot)) return result;

  const shadow = universe.shadow();
  const project = { gitDir: shadow.gitDir, workTree: projectRoot };
  const indexFile = path.join(universe.dir, "project.index");
  const git = (args: string[], options: { indexFile?: string; input?: string } = {}) =>
    runShadowGit(project, args, { cwd: projectRoot, allowFailure: true, ...options });

  // Snapshot the project's files into the shadow object store (stat-cached index).
  const added = await git(["add", "-A", "--", "."], { indexFile });
  if (added.code !== 0) return result;
  const tree = (await git(["write-tree"], { indexFile })).stdout.toString("utf8").trim();
  if (!tree) return result;
  const base = universe.meta.baseSha;
  const diff = await git(["diff-tree", "-r", "-z", "--no-renames", base, tree]);
  if (diff.code !== 0) return result;

  const updates: RawEntry[] = [];
  for (const entry of parseRaw(diff.stdout.toString("utf8"))) {
    if (entry.newMode === "160000" || entry.oldSha === entry.newSha) continue; // submodules: not copied
    const projectFile = resolveInside(projectRoot, entry.path);
    const copyFile = resolveInside(universe.workDir, entry.path);
    const removed = ZERO.test(entry.newSha);
    // A path missing from the snapshot but present on disk is ignored-yet-tracked, not deleted.
    if (removed && existsSync(projectFile)) continue;
    if (!removed && tooLarge(projectFile)) continue;

    const theirs = removed ? undefined : readReal(projectFile);
    if (!removed && theirs === undefined) continue; // vanished since the snapshot
    const baseContent = ZERO.test(entry.oldSha) ? undefined : (await git(["cat-file", "blob", entry.oldSha])).stdout;
    const ours = readReal(copyFile);

    if (same(ours, theirs)) {
      updates.push(entry); // the copy already agrees with the project
      continue;
    }
    if (same(ours, baseContent)) {
      // Only the project changed it: bring it in.
      if (removed) removeFile(copyFile, universe.workDir);
      else write(copyFile, entry, theirs!);
      updates.push(entry);
      result.pulled.push(entry.path);
      continue;
    }
    // Both changed it.
    if (ours && theirs && baseContent && isText(ours) && isText(theirs) && isText(baseContent) && entry.newMode !== "120000") {
      const merge = await threeWayMerge(ours, baseContent, theirs);
      if (merge.clean) {
        if (!merge.output.equals(ours)) {
          write(copyFile, entry, merge.output);
          result.merged.push(entry.path);
        }
        continue;
      }
    }
    result.conflicts.push(entry.path);
  }

  if (updates.length > 0) {
    universe.rebase(await advanceBase(universe, base, updates));
  }
  if (universe.meta.projectGit) {
    await refreshProjectGit(universe).catch(() => undefined);
  }
  if (result.pulled.length > 0 || result.merged.length > 0) {
    await universe.checkpoint({ kind: "tool", tool: "sync", summary: `brought in your changes: ${[...result.pulled, ...result.merged].slice(0, 5).join(", ")}` });
  }
  return result;
}

/** A new starting point: the old one with the project's version of each updated path. */
async function advanceBase(universe: Universe, base: string, updates: RawEntry[]): Promise<string> {
  const shadow = universe.shadow();
  const temp = path.join(universe.dir, "sync.index");
  const git = (args: string[], input?: string) => runShadowGit(shadow, args, { indexFile: temp, input });
  try {
    await git(["read-tree", base]);
    const lines = updates.map((u) => (ZERO.test(u.newSha) ? `0 ${"0".repeat(40)}\t${u.path}` : `${u.newMode} ${u.newSha}\t${u.path}`));
    await git(["update-index", "-z", "--index-info"], lines.map((l) => `${l}\0`).join(""));
    const tree = (await git(["write-tree"])).stdout.toString("utf8").trim();
    const commit = (await git(["commit-tree", tree, "-p", base, "-m", "starting point: brought in your changes"])).stdout.toString("utf8").trim();
    // Keep it reachable so nothing ever prunes it.
    await git(["update-ref", "refs/revcode/base", commit]);
    return commit;
  } finally {
    rmSync(temp, { force: true });
  }
}

function parseRaw(out: string): RawEntry[] {
  const fields = out.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/.exec(fields[i]);
    if (!match) continue;
    entries.push({ path: fields[i + 1], newMode: match[2] === "000000" ? match[1] : match[2], oldSha: match[3], newSha: match[4], status: match[5] });
  }
  return entries;
}

function write(target: string, entry: RawEntry, content: Buffer): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeItem(target, { isSymlink: entry.newMode === "120000", newMode: entry.newMode }, content);
}

function same(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

function tooLarge(file: string): boolean {
  try {
    return lstatSync(file).size > DEFAULT_LIMITS.maxFileBytes;
  } catch {
    return false;
  }
}
