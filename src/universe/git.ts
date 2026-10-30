/**
 * Thin wrapper around the `git` binary for a Universe's SHADOW repository.
 *
 * The shadow repo is a bare repository kept next to the universe's working copy
 * and driven with GIT_DIR/GIT_WORK_TREE. It exists only to snapshot the working
 * copy: it never touches the user's own `.git`, ignores their global git config
 * and hooks, and uses a fixed identity so snapshots work on any machine.
 */

import { execFile } from "node:child_process";
import path from "node:path";

const MAX_BUFFER = 256 * 1024 * 1024;

export interface ShadowGitHandle {
  gitDir: string;
  workTree: string;
}

export function shadowHandle(universeDir: string): ShadowGitHandle {
  return {
    gitDir: path.join(universeDir, "shadow.git"),
    workTree: path.join(universeDir, "work"),
  };
}

function gitEnv(handle: ShadowGitHandle): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: handle.gitDir,
    GIT_WORK_TREE: handle.workTree,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "revcode",
    GIT_AUTHOR_EMAIL: "revcode@localhost",
    GIT_COMMITTER_NAME: "revcode",
    GIT_COMMITTER_EMAIL: "revcode@localhost",
  };
}

const BASE_CONFIG = [
  "-c", "core.autocrlf=false",
  "-c", "core.safecrlf=false",
  "-c", "core.quotepath=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgsign=false",
  "-c", "gc.auto=0",
  "-c", "advice.addEmbeddedRepo=false",
];

export interface GitRunOptions {
  input?: string | Buffer;
  cwd?: string;
  /** Resolve with stdout even on non-zero exit (e.g. `merge-file`, `diff --exit-code`). */
  allowFailure?: boolean;
  /** Use this index file instead of the repository's own (GIT_INDEX_FILE). */
  indexFile?: string;
}

export interface GitResult {
  stdout: Buffer;
  code: number;
}

/** Run git against the shadow repo; rejects on non-zero exit unless allowFailure. */
export function runShadowGit(
  handle: ShadowGitHandle,
  args: string[],
  options: GitRunOptions = {},
): Promise<GitResult> {
  const env = options.indexFile ? { ...gitEnv(handle), GIT_INDEX_FILE: options.indexFile } : gitEnv(handle);
  return runGit([...BASE_CONFIG, ...args], env, options.cwd ?? handle.workTree, options);
}

/** Run git with no repository environment (merge-file, init of temp dirs, user repo queries). */
export function runPlainGit(
  args: string[],
  options: GitRunOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    ...(options.env ?? {}),
  };
  return runGit(args, env, options.cwd ?? process.cwd(), options);
}

function runGit(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: GitRunOptions,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { env, cwd, encoding: "buffer", maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((error as unknown as { code: number }).code)
            : error
              ? 1
              : 0;
        if (error && !options.allowFailure) {
          const detail = stderr.toString("utf8").trim() || error.message;
          reject(new Error(`git ${args.filter((a) => !a.startsWith("core.") && a !== "-c").slice(0, 4).join(" ")} failed: ${detail}`));
          return;
        }
        resolve({ stdout, code });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/** `git` stdout as trimmed text. */
export async function gitText(handle: ShadowGitHandle, args: string[], options: GitRunOptions = {}): Promise<string> {
  return (await runShadowGit(handle, args, options)).stdout.toString("utf8").trim();
}
