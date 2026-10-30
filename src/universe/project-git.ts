/**
 * Give a universe's working copy its own git repository that mirrors the real
 * project's, so the agent can use `git log`, `diff`, `blame` and `status` there.
 *
 * The mirror borrows the project's objects read-only (git "alternates") and
 * copies its refs, HEAD and index, so it is quick and takes almost no space.
 * Nothing is written to the project's own `.git`: commits, branches and stashes
 * made in the copy stay in the copy, and landing applies file changes only.
 * Remotes are copied too, so a push from the copy goes where the project's would;
 * the permission layer asks before any push.
 *
 * Only done when the project root is the repository's top level. Best effort:
 * any failure leaves the copy without a `.git`, exactly as before.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlainGit } from "./git.js";
import type { Universe } from "./universe.js";

/** Git settings for the mirror: no background gc, no fsmonitor daemon for a throwaway repo. */
const MIRROR_CONFIG: Array<[string, string]> = [
  ["gc.auto", "0"],
  ["core.fsmonitor", "false"],
  ["maintenance.auto", "false"],
];

export interface MirrorOptions {
  /** Tracked files that were not copied (too large): hidden from `git status` in the copy. */
  missing?: readonly string[];
  /** Dependency dirs linked (not copied) into the copy: a symlink isn't matched by `node_modules/` ignore rules. */
  linked?: readonly string[];
}

const git = (args: string[], cwd: string) => runPlainGit(args, { cwd, allowFailure: true, env: CLEAN_ENV });
const text = async (args: string[], cwd: string): Promise<string | undefined> => {
  const result = await git(args, cwd);
  return result.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
};

interface ProjectRepo {
  /** The project's git dir (per worktree): where its index lives. */
  own: string;
  /** Shared git dir: objects, refs, config. */
  common: string;
}

/** The project's repository, when the project root is its top level. */
async function projectRepo(projectRoot: string): Promise<ProjectRepo | undefined> {
  const top = await text(["rev-parse", "--show-toplevel"], projectRoot);
  if (!top || !samePath(top, projectRoot)) return undefined;
  const commonDir = await text(["rev-parse", "--git-common-dir"], projectRoot);
  const gitDir = await text(["rev-parse", "--git-dir"], projectRoot);
  if (!commonDir || !gitDir) return undefined;
  const repo = { own: path.resolve(projectRoot, gitDir), common: path.resolve(projectRoot, commonDir) };
  return existsSync(path.join(repo.common, "objects")) ? repo : undefined;
}

export async function mirrorProjectGit(projectRoot: string, workDir: string, options: MirrorOptions = {}): Promise<boolean> {
  const repo = await projectRepo(projectRoot);
  if (!repo) return false;
  const dotGit = path.join(workDir, ".git");
  try {
    if ((await git(["init", "-q", workDir], workDir)).code !== 0) return false;
    writeFileSync(path.join(dotGit, "objects", "info", "alternates"), `${path.join(repo.common, "objects")}\n`);
    const linked = (options.linked ?? []).filter(Boolean);
    if (linked.length > 0) {
      mkdirSync(path.join(dotGit, "info"), { recursive: true });
      appendFileSync(path.join(dotGit, "info", "exclude"), linked.map((name) => `/${name}\n`).join(""));
    }

    if (!(await fetchRefs(projectRoot, repo, workDir))) throw new Error("fetch failed");
    const head = await matchHead(projectRoot, workDir);

    // Same remotes, upstream tracking and identity as the project.
    const local = (await text(["config", "--local", "--get-regexp", "^(remote|branch|user)\\."], projectRoot)) ?? "";
    for (const line of local.split("\n").filter(Boolean)) {
      const space = line.indexOf(" ");
      const key = space === -1 ? line : line.slice(0, space);
      const value = space === -1 ? "" : line.slice(space + 1);
      await git(["config", "--add", key, value], workDir);
    }
    for (const [key, value] of MIRROR_CONFIG) await git(["config", key, value], workDir);

    if (head) await matchIndex(repo, workDir, options.missing);
    return true;
  } catch {
    rmSync(dotGit, { recursive: true, force: true });
    return false;
  }
}

/**
 * The project's HEAD moved since the copy was made (you committed, switched branch, pulled):
 * bring the copy's refs up to date, and its HEAD and index too unless the agent committed there.
 */
export async function refreshProjectGit(universe: Universe): Promise<void> {
  const { projectRoot } = universe.meta;
  const workDir = universe.workDir;
  const head = await text(["rev-parse", "-q", "--verify", "HEAD"], projectRoot);
  if (!head || head === universe.meta.projectHead || !existsSync(path.join(workDir, ".git"))) return;
  const repo = await projectRepo(projectRoot);
  if (!repo) return;
  const copyHead = await text(["rev-parse", "-q", "--verify", "HEAD"], workDir);
  await fetchRefs(projectRoot, repo, workDir);
  if (!copyHead || copyHead === universe.meta.projectHead) {
    await matchHead(projectRoot, workDir);
    await matchIndex(repo, workDir, universe.meta.skippedLarge);
  }
  universe.meta.projectHead = head;
  universe.saveMeta();
}

/** HEAD of a project, if it has commits. */
export async function gitHead(projectRoot: string): Promise<string | undefined> {
  return text(["rev-parse", "-q", "--verify", "HEAD"], projectRoot);
}

async function fetchRefs(projectRoot: string, repo: ProjectRepo, workDir: string): Promise<boolean> {
  if (existsSync(path.join(repo.common, "shallow"))) copyFileSync(path.join(repo.common, "shallow"), path.join(workDir, ".git", "shallow"));
  const fetched = await git(
    ["-c", "gc.auto=0", "fetch", "-q", "--no-tags", "--update-head-ok", "--no-write-fetch-head", projectRoot, "+refs/heads/*:refs/heads/*", "+refs/remotes/*:refs/remotes/*", "+refs/tags/*:refs/tags/*"],
    workDir,
  );
  return fetched.code === 0;
}

/** Point the copy's HEAD where the project's is (same branch, or detached at the same commit). */
async function matchHead(projectRoot: string, workDir: string): Promise<string | undefined> {
  const branch = await text(["symbolic-ref", "-q", "HEAD"], projectRoot);
  const head = await text(["rev-parse", "-q", "--verify", "HEAD"], projectRoot);
  if (branch) await git(["symbolic-ref", "HEAD", branch], workDir);
  else if (head) await git(["update-ref", "--no-deref", "HEAD", head], workDir);
  return head;
}

/** The project's own index keeps what the user had staged; rebuild from HEAD if it can't be used. */
async function matchIndex(repo: ProjectRepo, workDir: string, missing: readonly string[] = []): Promise<void> {
  const dotGit = path.join(workDir, ".git");
  // `diff --cached` reads the index without hashing the work tree: 0 or 1 means it is usable.
  if (!copyIndex(repo.own, dotGit) || (await git(["diff", "--cached", "--quiet"], workDir)).code > 1) {
    rmSync(path.join(dotGit, "index"), { force: true });
    await git(["reset", "-q"], workDir);
  }
  const hidden = missing.filter(Boolean);
  if (hidden.length > 0) await git(["update-index", "--skip-worktree", "--", ...hidden], workDir);
}

/** Copy the project's index (and split-index parts) into the mirror. */
function copyIndex(fromGitDir: string, toGitDir: string): boolean {
  try {
    const index = path.join(fromGitDir, "index");
    if (!existsSync(index)) return false;
    copyFileSync(index, path.join(toGitDir, "index"));
    for (const name of readdirSync(fromGitDir)) {
      if (name.startsWith("sharedindex.")) copyFileSync(path.join(fromGitDir, name), path.join(toGitDir, name));
    }
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** Never let an inherited GIT_DIR / GIT_WORK_TREE point these commands somewhere else. */
const CLEAN_ENV: NodeJS.ProcessEnv = { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_COMMON_DIR: undefined };
