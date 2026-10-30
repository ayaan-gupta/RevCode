/**
 * Copy a project into a universe's working directory.
 *
 * - Git projects: copy exactly the files git would consider part of the project
 *   (tracked + untracked-but-not-ignored), so build output and caches stay out.
 * - Other directories: walk the tree, skipping well-known heavyweight/ephemeral
 *   directories.
 * Dependency directories (node_modules, virtualenvs) are SYMLINKED rather than
 * copied: copying them is slow, and the agent needs them to run tests. They are
 * shared with the real project, which is called out in the universe metadata.
 */

import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { runPlainGit } from "./git.js";

const COPY_CONCURRENCY = 16;

/** Directory names never copied and never snapshotted. */
export const DEFAULT_EXCLUDES = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".next",
  ".nuxt",
  ".gradle",
  "target/debug",
  ".DS_Store",
] as const;

/** Top-level dependency directories shared (symlinked) into the universe. */
export const DEFAULT_LINKED = ["node_modules", ".venv", "venv"] as const;

export interface CopyLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: CopyLimits = {
  maxFiles: 150_000,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

export interface CopyResult {
  files: number;
  bytes: number;
  skippedLarge: string[];
  linked: string[];
}

export interface CopyOptions {
  linked?: readonly string[];
  limits?: Partial<CopyLimits>;
  /** Absolute paths never copied (RevCode's own state dir, which may live inside the project). */
  skipPaths?: readonly string[];
}

export class UniverseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniverseTooLargeError";
  }
}

export async function copyProject(source: string, dest: string, options: CopyOptions = {}): Promise<CopyResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const linkedNames = options.linked ?? DEFAULT_LINKED;
  mkdirSync(dest, { recursive: true });

  const result: CopyResult = { files: 0, bytes: 0, skippedLarge: [], linked: [] };

  const isGit = await isGitWorkTree(source);
  const relFiles = isGit ? await listGitFiles(source) : listWalk(source);

  const excluded = new Set<string>(DEFAULT_EXCLUDES);
  const skip = (options.skipPaths ?? []).map((p) => path.resolve(p));
  const madeDirs = new Set<string>();
  const ensureDir = (dir: string): void => {
    if (madeDirs.has(dir)) return;
    mkdirSync(dir, { recursive: true });
    madeDirs.add(dir);
  };
  const copies: Array<[string, string]> = [];
  for (const rel of relFiles) {
    if (hasExcludedSegment(rel, excluded)) {
      continue;
    }
    const from = path.join(source, rel);
    if (skip.some((p) => from === p || from.startsWith(p + path.sep))) {
      continue;
    }
    const to = path.join(dest, rel);
    let stat;
    try {
      stat = lstatSync(from);
    } catch {
      continue; // vanished between listing and copy
    }

    result.files += 1;
    if (result.files > limits.maxFiles) {
      throw new UniverseTooLargeError(
        `Project has more than ${limits.maxFiles.toLocaleString()} files; refusing to create a universe. Run from a subdirectory or exclude generated files via .gitignore.`,
      );
    }

    ensureDir(path.dirname(to));
    if (stat.isSymbolicLink()) {
      try {
        symlinkSync(readlinkSync(from), to);
      } catch {
        // already exists
      }
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    if (stat.size > limits.maxFileBytes) {
      result.skippedLarge.push(rel);
      result.files -= 1;
      continue;
    }
    result.bytes += stat.size;
    if (result.bytes > limits.maxTotalBytes) {
      throw new UniverseTooLargeError(
        `Project is larger than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB; refusing to create a universe.`,
      );
    }
    copies.push([from, to]);
  }

  // Copy in parallel: most of the time goes to per-file syscalls, not bytes.
  // FICLONE makes each one a copy-on-write reflink on filesystems that support it.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < copies.length) {
      const [from, to] = copies[next];
      next += 1;
      try {
        await copyFile(from, to, fsConstants.COPYFILE_FICLONE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // vanished since listing
        result.files -= 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, copies.length) }, worker));

  for (const name of linkedNames) {
    const target = path.join(source, name);
    const link = path.join(dest, name);
    if (existsSync(target) && !existsSync(link)) {
      try {
        symlinkSync(target, link, "dir");
        result.linked.push(name);
      } catch {
        // best effort
      }
    }
  }

  return result;
}

function hasExcludedSegment(rel: string, excluded: Set<string>): boolean {
  const segments = rel.split("/");
  for (let i = 0; i < segments.length; i += 1) {
    if (excluded.has(segments[i])) {
      return true;
    }
    // Two-segment patterns such as target/debug.
    if (i + 1 < segments.length && excluded.has(`${segments[i]}/${segments[i + 1]}`)) {
      return true;
    }
  }
  return false;
}

async function isGitWorkTree(dir: string): Promise<boolean> {
  try {
    const { stdout } = await runPlainGit(["rev-parse", "--is-inside-work-tree"], { cwd: dir, allowFailure: true });
    return stdout.toString("utf8").trim() === "true";
  } catch {
    return false;
  }
}

/** Tracked + untracked-not-ignored files, relative to `dir` (which may be a subdirectory of the repo). */
async function listGitFiles(dir: string): Promise<string[]> {
  const { stdout } = await runPlainGit(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--full-name", "--", "."],
    { cwd: dir },
  );
  const { stdout: prefixOut } = await runPlainGit(["rev-parse", "--show-prefix"], { cwd: dir });
  const prefix = prefixOut.toString("utf8").trim();
  const files = stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((file) => (prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file));
  return [...new Set(files)];
}

function listWalk(root: string): string[] {
  const out: string[] = [];
  const excluded = new Set<string>(DEFAULT_EXCLUDES);
  const walk = (relDir: string): void => {
    const abs = path.join(root, relDir);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (excluded.has(entry.name)) {
        continue;
      }
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk("");
  return out;
}
