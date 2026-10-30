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

export async function mirrorProjectGit(projectRoot: string, workDir: string, options: MirrorOptions = {}): Promise<boolean> {
  const git = (args: string[], cwd: string) => runPlainGit(args, { cwd, allowFailure: true, env: CLEAN_ENV });
  const text = async (args: string[], cwd: string): Promise<string | undefined> => {
    const result = await git(args, cwd);
    return result.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
  };

  const top = await text(["rev-parse", "--show-toplevel"], projectRoot);
  if (!top || !samePath(top, projectRoot)) return false;
  const commonDir = await text(["rev-parse", "--git-common-dir"], projectRoot);
  const gitDir = await text(["rev-parse", "--git-dir"], projectRoot);
  if (!commonDir || !gitDir) return false;
  const common = path.resolve(projectRoot, commonDir);
  const own = path.resolve(projectRoot, gitDir);
  const objects = path.join(common, "objects");
  if (!existsSync(objects)) return false;

  const dotGit = path.join(workDir, ".git");
  try {
    if ((await git(["init", "-q", workDir], workDir)).code !== 0) return false;
    writeFileSync(path.join(dotGit, "objects", "info", "alternates"), `${objects}\n`);
    const linked = (options.linked ?? []).filter(Boolean);
    if (linked.length > 0) {
      mkdirSync(path.join(dotGit, "info"), { recursive: true });
      appendFileSync(path.join(dotGit, "info", "exclude"), linked.map((name) => `/${name}\n`).join(""));
    }
    if (existsSync(path.join(common, "shallow"))) copyFileSync(path.join(common, "shallow"), path.join(dotGit, "shallow"));

    const fetched = await git(
      ["-c", "gc.auto=0", "fetch", "-q", "--no-tags", "--update-head-ok", "--no-write-fetch-head", projectRoot, "+refs/heads/*:refs/heads/*", "+refs/remotes/*:refs/remotes/*", "+refs/tags/*:refs/tags/*"],
      workDir,
    );
    if (fetched.code !== 0) throw new Error("fetch failed");

    const branch = await text(["symbolic-ref", "-q", "HEAD"], projectRoot);
    const head = await text(["rev-parse", "-q", "--verify", "HEAD"], projectRoot);
    if (branch) {
      await git(["symbolic-ref", "HEAD", branch], workDir);
    } else if (head) {
      await git(["update-ref", "--no-deref", "HEAD", head], workDir);
    }

    // Same remotes, upstream tracking and identity as the project.
    const local = (await text(["config", "--local", "--get-regexp", "^(remote|branch|user)\\."], projectRoot)) ?? "";
    for (const line of local.split("\n").filter(Boolean)) {
      const space = line.indexOf(" ");
      const key = space === -1 ? line : line.slice(0, space);
      const value = space === -1 ? "" : line.slice(space + 1);
      await git(["config", "--add", key, value], workDir);
    }
    for (const [key, value] of MIRROR_CONFIG) await git(["config", key, value], workDir);

    if (head) {
      // The project's own index keeps what the user had staged; rebuild from HEAD if it can't be used.
      // `diff --cached` reads the index without hashing the work tree: 0 or 1 means it is usable.
      if (!copyIndex(own, dotGit) || (await git(["diff", "--cached", "--quiet"], workDir)).code > 1) {
        rmSync(path.join(dotGit, "index"), { force: true });
        await git(["reset", "-q"], workDir);
      }
      const missing = (options.missing ?? []).filter(Boolean);
      if (missing.length > 0) await git(["update-index", "--skip-worktree", "--", ...missing], workDir);
    }
    return true;
  } catch {
    rmSync(dotGit, { recursive: true, force: true });
    return false;
  }
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
