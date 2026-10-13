/**
 * Landing: apply a universe's changeset onto the real project.
 *
 * `planLand` is a pure read — it compares three versions of every changed file
 * (BASE = the project when the universe was created, THEIRS = the universe now,
 * OURS = the real project right now) and decides what would happen. `applyLand`
 * then executes the plan. Files the project changed independently are merged
 * with `git merge-file`; true conflicts are never silently overwritten.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPlainGit, runShadowGit } from "./git.js";
import type { Universe } from "./universe.js";

export type ChangeStatus = "A" | "M" | "D" | "T";

export type LandAction =
  | "write" // apply universe version (project untouched since base, or clean merge)
  | "delete"
  | "identical" // project already has this content
  | "already-gone"
  | "conflict"; // project and universe both changed it

export interface LandItem {
  path: string;
  status: ChangeStatus;
  action: LandAction;
  /** Why this is a conflict / what kind of merge happened. */
  detail?: string;
  /** True when a 3-way merge combined independent edits. */
  merged?: boolean;
  newMode: string;
  oldMode: string;
  /** Content to write (universe version, or merge result). */
  content?: Buffer;
  /** Conflict-marker version, for `--markers`. */
  conflictContent?: Buffer;
  /** The universe's own version (for `theirs`). */
  theirs?: Buffer;
  isSymlink?: boolean;
}

export interface LandPlan {
  universeId: string;
  projectRoot: string;
  headSha: string;
  baseSha: string;
  /** True when only a subset of the changeset was selected. */
  partial: boolean;
  items: LandItem[];
}

export type ConflictStrategy = "skip" | "markers" | "theirs";

export interface LandResult {
  written: string[];
  deleted: string[];
  merged: string[];
  conflicts: string[];
  skipped: string[];
}

interface RawChange {
  path: string;
  status: ChangeStatus;
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
}

export async function planLand(universe: Universe, options: { paths?: string[] } = {}): Promise<LandPlan> {
  const headSha = await universe.snapshotHead("pre-land snapshot");
  const baseSha = universe.meta.baseSha;
  const projectRoot = universe.meta.projectRoot;

  const raw = await rawChanges(universe, baseSha, headSha);
  const wanted = options.paths && options.paths.length > 0 ? new Set(options.paths.map(normalizeRel)) : undefined;

  const items: LandItem[] = [];
  for (const change of raw) {
    if (wanted && !wanted.has(change.path) && ![...wanted].some((w) => change.path.startsWith(`${w}/`))) {
      continue;
    }
    items.push(await planItem(universe, change, projectRoot));
  }
  return { universeId: universe.id, projectRoot, headSha, baseSha, partial: wanted !== undefined, items };
}

async function planItem(universe: Universe, change: RawChange, projectRoot: string): Promise<LandItem> {
  const handle = universe.shadow();
  const base: LandItem = {
    path: change.path,
    status: change.status,
    action: "write",
    oldMode: change.oldMode,
    newMode: change.newMode,
    isSymlink: change.newMode === "120000",
  };

  const target = resolveInside(projectRoot, change.path);
  const real = readReal(target);
  const baseBlob = change.status === "A" ? undefined : await blob(handle, change.oldSha);
  const headBlob = change.status === "D" ? undefined : await blob(handle, change.newSha);
  base.theirs = headBlob;

  if (change.status === "D") {
    if (real === undefined) return { ...base, action: "already-gone" };
    if (baseBlob && real.equals(baseBlob)) return { ...base, action: "delete" };
    return { ...base, action: "conflict", detail: "deleted in the universe but modified in the project" };
  }

  if (change.status === "A") {
    if (real === undefined) return { ...base, content: headBlob };
    if (headBlob && real.equals(headBlob)) return { ...base, action: "identical" };
    return { ...base, action: "conflict", detail: "added in the universe but a different file already exists in the project", conflictContent: headBlob };
  }

  // M / T
  if (real === undefined) {
    return { ...base, action: "conflict", detail: "modified in the universe but deleted in the project" };
  }
  if (headBlob && real.equals(headBlob)) return { ...base, action: "identical" };
  if (baseBlob && real.equals(baseBlob)) return { ...base, content: headBlob };

  // Both sides changed it: attempt a text 3-way merge.
  if (baseBlob && headBlob && isText(baseBlob) && isText(real) && isText(headBlob) && !base.isSymlink) {
    const merge = await threeWayMerge(real, baseBlob, headBlob);
    if (merge.clean) return { ...base, content: merge.output, merged: true, detail: "merged with independent changes in the project" };
    return { ...base, action: "conflict", detail: `${merge.conflicts} overlapping change${merge.conflicts === 1 ? "" : "s"} in both the project and the universe`, conflictContent: merge.output };
  }
  return { ...base, action: "conflict", detail: "binary or symlink changed on both sides" };
}

export async function applyLand(
  universe: Universe,
  plan: LandPlan,
  options: { onConflict?: ConflictStrategy } = {},
): Promise<LandResult> {
  const strategy = options.onConflict ?? "skip";
  const result: LandResult = { written: [], deleted: [], merged: [], conflicts: [], skipped: [] };

  for (const item of plan.items) {
    const target = resolveInside(plan.projectRoot, item.path);

    switch (item.action) {
      case "identical":
      case "already-gone":
        result.skipped.push(item.path);
        break;
      case "delete":
        removeFile(target, plan.projectRoot);
        result.deleted.push(item.path);
        break;
      case "write":
        writeItem(target, item, item.content ?? Buffer.alloc(0));
        result.written.push(item.path);
        if (item.merged) result.merged.push(item.path);
        break;
      case "conflict":
        if (strategy === "theirs" && item.theirs) {
          writeItem(target, item, item.theirs);
          result.written.push(item.path);
        } else if (strategy === "markers" && item.conflictContent) {
          writeItem(target, item, item.conflictContent);
          result.written.push(item.path);
          result.conflicts.push(item.path);
        } else if (strategy === "theirs" && item.status === "D") {
          removeFile(target, plan.projectRoot);
          result.deleted.push(item.path);
        } else {
          result.conflicts.push(item.path);
        }
        break;
    }
  }

  universe.markLanded();
  // Only advance the merge base when nothing was left behind; otherwise unresolved
  // files would silently stop showing up in later lands.
  const complete = result.conflicts.length === 0 && !plan.partial;
  await universe.checkpoint({ kind: "land", summary: `landed ${result.written.length} written, ${result.deleted.length} deleted, ${result.conflicts.length} conflicts` });
  if (complete) {
    universe.rebase(plan.headSha);
  }
  return result;
}

// --- helpers ------------------------------------------------------------------

async function rawChanges(universe: Universe, baseSha: string, headSha: string): Promise<RawChange[]> {
  const handle = universe.shadow();
  const out = (await runShadowGit(handle, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", baseSha, headSha])).stdout.toString("utf8");
  const fields = out.split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i];
    const file = fields[i + 1];
    const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])$/.exec(meta);
    if (!match || !file) continue;
    changes.push({
      path: file,
      oldMode: match[1],
      newMode: match[2],
      oldSha: match[3],
      newSha: match[4],
      status: match[5] as ChangeStatus,
    });
  }
  return changes;
}

async function blob(handle: ReturnType<Universe["shadow"]>, sha: string): Promise<Buffer> {
  return (await runShadowGit(handle, ["cat-file", "blob", sha])).stdout;
}

function normalizeRel(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Resolve a repo-relative path inside the project root, refusing anything that escapes it. */
export function resolveInside(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to land a path outside the project: ${rel}`);
  }
  // Guard against a symlinked parent directory pointing outside the project.
  let probe = path.dirname(resolved);
  while (!existsSync(probe) && probe !== root) {
    probe = path.dirname(probe);
  }
  if (existsSync(probe)) {
    const realProbe = realpathSync(probe);
    const realRoot = realpathSync(root);
    const within = path.relative(realRoot, realProbe);
    if (within.startsWith("..") || path.isAbsolute(within)) {
      throw new Error(`Refusing to land through a symlink that leaves the project: ${rel}`);
    }
  }
  return resolved;
}

function readReal(target: string): Buffer | undefined {
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(target));
    if (stat.isFile()) return readFileSync(target);
    return undefined;
  } catch {
    return undefined;
  }
}

function isText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8000).includes(0);
}

async function threeWayMerge(ours: Buffer, base: Buffer, theirs: Buffer): Promise<{ clean: boolean; output: Buffer; conflicts: number }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-merge-"));
  try {
    const oursFile = path.join(dir, "ours");
    const baseFile = path.join(dir, "base");
    const theirsFile = path.join(dir, "theirs");
    writeFileSync(oursFile, ours);
    writeFileSync(baseFile, base);
    writeFileSync(theirsFile, theirs);
    const result = await runPlainGit(
      ["merge-file", "-p", "-L", "project", "-L", "base", "-L", "universe", oursFile, baseFile, theirsFile],
      { allowFailure: true },
    );
    // Exit code = number of conflicts (capped at 127); >=128 means an error.
    if (result.code >= 128) {
      return { clean: false, output: ours, conflicts: 1 };
    }
    return { clean: result.code === 0, output: result.stdout, conflicts: result.code };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeItem(target: string, item: LandItem, content: Buffer): void {
  mkdirSync(path.dirname(target), { recursive: true });
  if (item.isSymlink) {
    try {
      unlinkSync(target);
    } catch {
      // not present
    }
    symlinkSync(content.toString("utf8"), target);
    return;
  }
  const temp = `${target}.revcode-${process.pid}.tmp`;
  writeFileSync(temp, content);
  if (item.newMode === "100755") {
    chmodSync(temp, 0o755);
  } else if (item.newMode === "100644") {
    chmodSync(temp, 0o644);
  }
  renameSync(temp, target);
}

function removeFile(target: string, root: string): void {
  try {
    unlinkSync(target);
  } catch {
    return;
  }
  // Tidy now-empty parent directories (never the project root itself).
  let dir = path.dirname(target);
  while (dir !== root && dir.startsWith(root)) {
    try {
      if (readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

/** One-line human summary of a plan. */
export function summarizePlan(plan: LandPlan): string {
  const count = (action: LandAction) => plan.items.filter((i) => i.action === action).length;
  const merged = plan.items.filter((i) => i.merged).length;
  const parts = [
    `${count("write")} to write${merged ? ` (${merged} auto-merged)` : ""}`,
    `${count("delete")} to delete`,
    `${count("conflict")} conflict${count("conflict") === 1 ? "" : "s"}`,
  ];
  const identical = count("identical") + count("already-gone");
  if (identical) parts.push(`${identical} already in place`);
  return parts.join(", ");
}
