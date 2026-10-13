/**
 * Where skills and custom commands are looked up.
 *
 * Roots are returned lowest -> highest precedence so callers can let later
 * entries override earlier ones by name. Project roots are collected from the
 * git root down to `cwd`, so a nested package's `.revcode/skills` beats the
 * repo-wide one.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { revcodeHome } from "../config/paths.js";

export interface DiscoveryOptions {
  /** Replaces `os.homedir()` for the `~/.claude` and `~/.agents` roots (tests). */
  homeDir?: string;
  /** Replaces `revcodeHome()` for the `~/.revcode` root (tests). */
  revcodeHome?: string;
}

export interface SearchRoot {
  dir: string;
  scope: "user" | "project";
}

export type RootKind = "skills" | "commands";

/** Nearest ancestor of `start` (inclusive) containing `.git`, a directory or a worktree file. */
export function findGitRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Directories from the git root down to `cwd`, outermost first. Outside a
 * repository only `cwd` counts: walking to `/` would mistake `~/.claude` for a
 * project directory.
 */
export function projectDirs(cwd: string): string[] {
  const start = path.resolve(cwd);
  const root = findGitRoot(start);
  if (!root) {
    return [start];
  }
  const dirs: string[] = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (dir === root) {
      return dirs;
    }
  }
}

/**
 * Skills: user `~/.revcode`, `~/.claude`, `~/.agents`, then per project
 * directory `.claude`, `.agents`, `.revcode`. Commands have no `.agents`
 * convention, and RevCode's own directory beats Claude's at both levels.
 */
export function searchRoots(cwd: string, kind: RootKind, options: DiscoveryOptions = {}): SearchRoot[] {
  const home = options.homeDir ?? os.homedir();
  const revcode = options.revcodeHome ?? revcodeHome();

  const user: string[] =
    kind === "skills"
      ? [path.join(revcode, "skills"), path.join(home, ".claude", "skills"), path.join(home, ".agents", "skills")]
      : [path.join(home, ".claude", "commands"), path.join(revcode, "commands")];
  const names = kind === "skills" ? [".claude", ".agents", ".revcode"] : [".claude", ".revcode"];

  const roots: SearchRoot[] = [
    ...user.map((dir) => ({ dir, scope: "user" as const })),
    ...projectDirs(cwd).flatMap((dir) =>
      names.map((name) => ({ dir: path.join(dir, name, kind), scope: "project" as const })),
    ),
  ];

  // When the repo root is $HOME the same directory shows up as user and project;
  // keep the first (user) occurrence so it does not jump up the precedence list.
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = path.resolve(root.dir);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
