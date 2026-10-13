/**
 * Parallel Universes.
 *
 * A Universe is an isolated, recorded copy of a project in which an agent runs
 * with full freedom. Nothing reaches the real project until the user LANDS it.
 *
 *   ~/.revcode/universes/<id>/
 *     meta.json        identity, base snapshot, lineage
 *     work/            the working copy the agent's cwd points at
 *     shadow.git/      bare git repo snapshotting work/ at every checkpoint
 *     timeline.jsonl   checkpoints, prompts, receipts (the replayable record)
 *
 * Because every mutating tool call is checkpointed into the shadow repo, a
 * universe can be rewound to any step, forked into a sibling timeline, diffed
 * against its base, replayed on another model, and landed with a 3-way merge.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { safeSegment, universesDir } from "../config/paths.js";
import { copyProject, DEFAULT_EXCLUDES, type CopyOptions } from "./copy.js";
import { gitText, runPlainGit, runShadowGit, shadowHandle, type ShadowGitHandle } from "./git.js";

export type UniverseStatus = "active" | "landed" | "discarded";

export interface UniverseMeta {
  id: string;
  name?: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  status: UniverseStatus;
  /** Snapshot of the project when the universe was created (the land merge base). */
  baseSha: string;
  parentId?: string;
  forkedFromSha?: string;
  provider?: string;
  model?: string;
  /** Dependency dirs symlinked (shared) with the real project. */
  linked: string[];
  skippedLarge: string[];
  landedCount: number;
  lastLandedAt?: string;
}

export interface FileChange {
  path: string;
  status: "A" | "M" | "D";
  insertions: number;
  deletions: number;
}

export type CheckpointKind = "base" | "tool" | "turn" | "rewind" | "fork" | "land";

export interface Checkpoint {
  type: "checkpoint";
  n: number;
  sha: string;
  at: string;
  kind: CheckpointKind;
  tool?: string;
  summary: string;
  /** Whether the working tree differed from the previous checkpoint. */
  changed: boolean;
  /** Conversation length when taken (used to rewind the conversation too). */
  messageCount?: number;
  turn?: number;
  exitCode?: number | null;
}

export interface PromptRecord {
  type: "prompt";
  at: string;
  turn: number;
  text: string;
}

export type TimelineEntry = Checkpoint | PromptRecord | { type: "receipt"; at: string; [key: string]: unknown } | { type: "note"; at: string; text: string };

export interface CheckpointInfo {
  kind: CheckpointKind;
  tool?: string;
  summary: string;
  messageCount?: number;
  turn?: number;
  exitCode?: number | null;
}

export interface CreateUniverseOptions extends CopyOptions {
  projectRoot: string;
  id?: string;
  name?: string;
  provider?: string;
  model?: string;
}

export class Universe {
  readonly dir: string;
  readonly workDir: string;
  private readonly handle: ShadowGitHandle;
  private lock: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly meta: UniverseMeta,
    dir: string,
  ) {
    this.dir = dir;
    this.handle = shadowHandle(dir);
    this.workDir = this.handle.workTree;
  }

  get id(): string {
    return this.meta.id;
  }

  // --- lifecycle ------------------------------------------------------------

  static async create(options: CreateUniverseOptions): Promise<Universe> {
    const projectRoot = path.resolve(options.projectRoot);
    assertSafeProjectRoot(projectRoot);

    const id = options.id ?? newUniverseId();
    const dir = path.join(universesDir(), safeSegment(id));
    if (existsSync(dir)) {
      throw new Error(`Universe ${id} already exists`);
    }
    mkdirSync(dir, { recursive: true });
    const handle = shadowHandle(dir);

    try {
      const copied = await copyProject(projectRoot, handle.workTree, options);
      await initShadow(handle);

      const now = new Date().toISOString();
      const meta: UniverseMeta = {
        id,
        name: options.name,
        projectRoot,
        createdAt: now,
        updatedAt: now,
        status: "active",
        baseSha: "",
        provider: options.provider,
        model: options.model,
        linked: copied.linked,
        skippedLarge: copied.skippedLarge,
        landedCount: 0,
      };
      const universe = new Universe(meta, dir);
      const base = await universe.checkpointLocked({
        kind: "base",
        summary: `Universe created from ${projectRoot} (${copied.files} files)`,
      });
      meta.baseSha = base.sha;
      universe.saveMeta();
      return universe;
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  static open(id: string): Universe {
    const dir = path.join(universesDir(), safeSegment(id));
    const metaFile = path.join(dir, "meta.json");
    if (!existsSync(metaFile)) {
      throw new Error(`No such universe: ${id}`);
    }
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as UniverseMeta;
    return new Universe(meta, dir);
  }

  static list(filter?: { projectRoot?: string; includeDiscarded?: boolean }): UniverseMeta[] {
    const root = universesDir();
    if (!existsSync(root)) {
      return [];
    }
    const metas: UniverseMeta[] = [];
    for (const entry of readdirSync(root)) {
      const metaFile = path.join(root, entry, "meta.json");
      if (!existsSync(metaFile)) {
        continue;
      }
      try {
        const meta = JSON.parse(readFileSync(metaFile, "utf8")) as UniverseMeta;
        if (!filter?.includeDiscarded && meta.status === "discarded") continue;
        if (filter?.projectRoot && path.resolve(filter.projectRoot) !== meta.projectRoot) continue;
        metas.push(meta);
      } catch {
        // skip unreadable
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // --- checkpoints ----------------------------------------------------------

  /** Snapshot the working tree and append a checkpoint to the timeline. */
  checkpoint(info: CheckpointInfo): Promise<Checkpoint> {
    return this.exclusive(() => this.checkpointLocked(info));
  }

  private async checkpointLocked(info: CheckpointInfo): Promise<Checkpoint> {
    await runShadowGit(this.handle, ["add", "-A", "--", "."]);
    const hasHead = (await runShadowGit(this.handle, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true })).code === 0;
    const dirty = hasHead
      ? (await runShadowGit(this.handle, ["diff", "--cached", "--quiet", "HEAD"], { allowFailure: true })).code !== 0
      : true;

    const mustCommit = dirty || info.kind === "base" || info.kind === "turn" || info.kind === "rewind" || info.kind === "fork" || info.kind === "land";
    if (mustCommit) {
      await runShadowGit(this.handle, ["commit", "--allow-empty", "-q", "--no-verify", "-m", `${info.kind}: ${info.summary}`.slice(0, 200)]);
    }
    const sha = await gitText(this.handle, ["rev-parse", "HEAD"]);

    const previous = this.checkpoints().at(-1);
    const n = (previous?.n ?? 0) + 1;
    await runShadowGit(this.handle, ["tag", "-f", `cp-${n}`, sha]);

    const checkpoint: Checkpoint = {
      type: "checkpoint",
      n,
      sha,
      at: new Date().toISOString(),
      kind: info.kind,
      tool: info.tool,
      summary: info.summary,
      changed: dirty,
      messageCount: info.messageCount,
      turn: info.turn,
      exitCode: info.exitCode,
    };
    this.appendTimeline(checkpoint);
    return checkpoint;
  }

  /** Commit sha of the current working tree state (snapshotting first). */
  async snapshotHead(summary = "snapshot"): Promise<string> {
    return (await this.checkpoint({ kind: "tool", summary })).sha;
  }

  // --- timeline -------------------------------------------------------------

  timeline(): TimelineEntry[] {
    const file = path.join(this.dir, "timeline.jsonl");
    if (!existsSync(file)) {
      return [];
    }
    const entries: TimelineEntry[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as TimelineEntry);
      } catch {
        // tolerate a torn final line
      }
    }
    return entries;
  }

  checkpoints(): Checkpoint[] {
    return this.timeline().filter((e): e is Checkpoint => e.type === "checkpoint");
  }

  checkpointByNumber(n: number): Checkpoint | undefined {
    return this.checkpoints().find((c) => c.n === n);
  }

  appendTimeline(entry: TimelineEntry): void {
    appendFileSync(path.join(this.dir, "timeline.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
    this.touch();
  }

  recordPrompt(turn: number, text: string): void {
    this.appendTimeline({ type: "prompt", at: new Date().toISOString(), turn, text });
  }

  prompts(): PromptRecord[] {
    return this.timeline().filter((e): e is PromptRecord => e.type === "prompt");
  }

  // --- time travel ----------------------------------------------------------

  /**
   * Restore the working tree to checkpoint `n`. The current state is
   * snapshotted first, so a rewind is itself undoable.
   */
  async rewind(n: number): Promise<Checkpoint> {
    const target = this.checkpointByNumber(n);
    if (!target) {
      throw new Error(`No checkpoint #${n} in universe ${this.id}`);
    }
    return this.exclusive(async () => {
      await this.checkpointLocked({ kind: "tool", summary: `state before rewind to #${n}` });
      await runShadowGit(this.handle, ["reset", "--hard", "-q", target.sha]);
      await runShadowGit(this.handle, ["clean", "-fdq"]);
      return this.checkpointLocked({
        kind: "rewind",
        summary: `rewound to #${n} (${target.summary})`,
        messageCount: target.messageCount,
        turn: target.turn,
      });
    });
  }

  /** Create a sibling universe whose working tree equals checkpoint `n` (default: now). */
  async fork(n?: number, options: { name?: string } = {}): Promise<Universe> {
    const source = n === undefined ? await this.snapshotHead("fork point") : this.checkpointByNumber(n)?.sha;
    if (!source) {
      throw new Error(`No checkpoint #${n} in universe ${this.id}`);
    }
    const sourceCheckpoint = n === undefined ? this.checkpoints().at(-1) : this.checkpointByNumber(n);

    const id = newUniverseId();
    const dir = path.join(universesDir(), safeSegment(id));
    mkdirSync(dir, { recursive: true });
    const handle = shadowHandle(dir);

    try {
      // A local clone shares objects via hardlinks, so forking is cheap.
      await runPlainGit(["clone", "--bare", "-q", this.handle.gitDir, handle.gitDir], { cwd: this.dir });
      mkdirSync(handle.workTree, { recursive: true });
      writeExcludes(handle);
      await runShadowGit(handle, ["checkout", "-f", "-q", "-B", "main", source]);

      for (const name of this.meta.linked) {
        const target = path.join(this.meta.projectRoot, name);
        if (existsSync(target)) {
          symlinkSync(target, path.join(handle.workTree, name), "dir");
        }
      }

      const now = new Date().toISOString();
      const meta: UniverseMeta = {
        ...this.meta,
        id,
        name: options.name ?? (this.meta.name ? `${this.meta.name} (fork)` : undefined),
        createdAt: now,
        updatedAt: now,
        status: "active",
        parentId: this.id,
        forkedFromSha: source,
        landedCount: 0,
        lastLandedAt: undefined,
      };
      const child = new Universe(meta, dir);

      // Carry the lineage up to the fork point so the fork's timeline reads as one
      // continuous story. The timeline is append-only, so position is authoritative:
      // everything after the fork point's checkpoint belongs to the parent alone.
      const entries = this.timeline();
      const cut = sourceCheckpoint
        ? entries.findIndex((entry) => entry.type === "checkpoint" && entry.n === sourceCheckpoint.n)
        : entries.length - 1;
      for (const entry of entries.slice(0, cut + 1)) {
        child.appendTimeline(entry);
      }
      child.saveMeta();
      return child;
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  // --- changes --------------------------------------------------------------

  /** Files changed between the base snapshot and the current state. */
  async changedFiles(): Promise<string[]> {
    const head = await this.snapshotHead("changed-files probe");
    const out = await gitText(this.handle, ["diff", "--name-only", "-z", "--no-renames", this.meta.baseSha, head]);
    return out.split("\0").filter(Boolean);
  }

  /** Unified diff base → current (optionally limited to paths). */
  async diff(paths: string[] = []): Promise<string> {
    const head = await this.snapshotHead("diff probe");
    const args = ["diff", "--no-renames", "--no-color", this.meta.baseSha, head];
    if (paths.length > 0) {
      args.push("--", ...paths);
    }
    return (await runShadowGit(this.handle, args)).stdout.toString("utf8");
  }

  /** Per-file changes between two snapshots of this universe (status + line counts). */
  async changesBetween(from: string, to: string): Promise<FileChange[]> {
    if (from === to) {
      return [];
    }
    const status = (
      await runShadowGit(this.handle, ["diff", "--name-status", "-z", "--no-renames", from, to])
    ).stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const counts = new Map<string, { insertions: number; deletions: number }>();
    const numstat = (await runShadowGit(this.handle, ["diff", "--numstat", "-z", "--no-renames", from, to])).stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    for (const record of numstat) {
      const [add, del, ...rest] = record.split("\t");
      counts.set(rest.join("\t"), { insertions: Number(add) || 0, deletions: Number(del) || 0 });
    }
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < status.length; i += 2) {
      const code = status[i][0] as "A" | "M" | "D" | "T";
      const file = status[i + 1];
      changes.push({ path: file, status: code === "T" ? "M" : code, ...(counts.get(file) ?? { insertions: 0, deletions: 0 }) });
    }
    return changes;
  }

  /** Which of `paths` already existed when the universe was created. */
  async existedAtBase(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) {
      return new Set();
    }
    const out = (await runShadowGit(this.handle, ["ls-tree", "-r", "--name-only", "-z", this.meta.baseSha, "--", ...paths])).stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return new Set(out);
  }

  async diffStat(): Promise<{ files: number; insertions: number; deletions: number }> {
    const head = await this.snapshotHead("stat probe");
    const out = (await runShadowGit(this.handle, ["diff", "--numstat", "-z", "--no-renames", this.meta.baseSha, head])).stdout.toString("utf8");
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const record of out.split("\0").filter(Boolean)) {
      const [add, del] = record.split("\t");
      files += 1;
      insertions += Number(add) || 0;
      deletions += Number(del) || 0;
    }
    return { files, insertions, deletions };
  }

  // --- internals used by landing / export -----------------------------------

  shadow(): ShadowGitHandle {
    return this.handle;
  }

  /** Move the land merge-base forward (after a clean land). */
  rebase(sha: string): void {
    this.meta.baseSha = sha;
    this.saveMeta();
  }

  markLanded(): void {
    this.meta.landedCount += 1;
    this.meta.lastLandedAt = new Date().toISOString();
    this.saveMeta();
  }

  /** Remove the working copy and shadow repo; keep meta + timeline for history. */
  discard(): void {
    rmSync(this.workDir, { recursive: true, force: true });
    rmSync(this.handle.gitDir, { recursive: true, force: true });
    this.meta.status = "discarded";
    this.saveMeta();
  }

  /** Remove everything, including history. */
  purge(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  setModel(provider: string | undefined, model: string | undefined): void {
    this.meta.provider = provider;
    this.meta.model = model;
    this.saveMeta();
  }

  saveMeta(): void {
    this.meta.updatedAt = new Date().toISOString();
    writeFileSync(path.join(this.dir, "meta.json"), `${JSON.stringify(this.meta, null, 2)}\n`, "utf8");
  }

  private touch(): void {
    // Cheap liveness marker so `list` orders by recent activity without rewriting meta each call.
    this.meta.updatedAt = new Date().toISOString();
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lock.then(task, task);
    this.lock = run.catch(() => undefined);
    return run;
  }
}

// --- helpers ------------------------------------------------------------------

export function newUniverseId(): string {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(2, 12);
  return `u${stamp}-${randomBytes(2).toString("hex")}`;
}

function assertSafeProjectRoot(projectRoot: string): void {
  const home = process.env.HOME ? path.resolve(process.env.HOME) : undefined;
  if (projectRoot === path.parse(projectRoot).root || projectRoot === home) {
    throw new Error(
      `Refusing to create a universe from ${projectRoot}: it is a filesystem root or your home directory. Run RevCode from inside a project directory.`,
    );
  }
}

async function initShadow(handle: ShadowGitHandle): Promise<void> {
  mkdirSync(handle.gitDir, { recursive: true });
  await runPlainGit(["init", "-q", "--bare", "-b", "main", handle.gitDir]);
  writeExcludes(handle);
}

/** Keep dependency dirs and caches out of snapshots (clones don't inherit info/exclude). */
function writeExcludes(handle: ShadowGitHandle): void {
  const infoDir = path.join(handle.gitDir, "info");
  mkdirSync(infoDir, { recursive: true });
  writeFileSync(path.join(infoDir, "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`, "utf8");
}
