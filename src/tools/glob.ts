/**
 * Tool: find files by glob pattern.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { formatRelativePath, resolvePathInsideCwd } from "./path.js";

const execFileAsync = promisify(execFile);
const MAX_RESULTS = 500;

export interface GlobToolInput {
  pattern: string;
  path?: string;
}

export interface GlobToolOutput {
  matches: string[];
  content: string;
}

export interface GlobToolOptions {
  cwd?: string;
  /** Allow paths outside the working directory. */
  unrestricted?: boolean;
  /** ripgrep binary (tests point this at a missing one to exercise the fallback). */
  rg?: string;
}

export async function globFiles(
  input: GlobToolInput,
  options: GlobToolOptions = {},
): Promise<GlobToolOutput> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const searchPath = resolvePathInsideCwd(normalizedInput.path ?? ".", cwd, options.unrestricted);
  const relativeSearchPath = formatRelativePath(searchPath, cwd);

  const args = ["--files", "-g", normalizedInput.pattern, relativeSearchPath];

  try {
    let listed: string[];
    try {
      const { stdout } = await execFileAsync(options.rg ?? "rg", args, { cwd });
      listed = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch (error) {
      if (!(isProcessError(error) && error.code === "ENOENT")) throw error;
      listed = await globFallback(normalizedInput.pattern, searchPath, relativeSearchPath);
      if (listed.length === 0) throw Object.assign(new Error("no matches"), { code: 1 });
    }
    const matches = listed.slice(0, MAX_RESULTS);

    const content =
      matches.length === 0
        ? `(no files matched pattern ${normalizedInput.pattern} under ${relativeSearchPath})`
        : `[${matches.length} matches]\n${matches.join("\n")}`;

    return { matches, content };
  } catch (error) {
    if (isProcessError(error) && error.code === 1) {
      return {
        matches: [],
        content: `(no files matched pattern ${normalizedInput.pattern} under ${relativeSearchPath})`,
      };
    }

    throw new Error(
      `glob failed for ${relativeSearchPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** ripgrep isn't installed: list the files git knows about (or walk the tree) and match in-process. */
async function globFallback(pattern: string, searchPath: string, shownPath: string): Promise<string[]> {
  let files: string[];
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], { cwd: searchPath, maxBuffer: 64 * 1024 * 1024 });
    files = stdout.split("\0").filter((file) => file && existsSync(path.join(searchPath, file)));
  } catch {
    files = walk(searchPath);
  }
  const re = globToRegExp(pattern.replace(/^\//, ""));
  const anchored = pattern.replace(/^\*\*\//, "").includes("/");
  return files
    .filter((file) => !file.split("/").some((part) => WALK_SKIP.has(part) || part === ".git"))
    .filter((file) => re.test(file) || (!anchored && re.test(path.posix.basename(file))))
    .map((file) => (shownPath === "." ? file : path.posix.join(shownPath, file)));
}

const WALK_SKIP = new Set(["node_modules", "__pycache__", "venv", ".venv", "target", "dist", "build"]);

function walk(root: string, rel = "", out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || WALK_SKIP.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, child, out);
    else out.push(child);
    if (out.length > 50_000) break;
  }
  return out;
}

/** gitignore-style glob → RegExp over a slash-separated relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) {
        re += "\\{";
      } else {
        re += `(?:${glob.slice(i + 1, close).split(",").map((part) => globToRegExp(part).source.slice(1, -1)).join("|")})`;
        i = close;
      }
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) re += "\\[";
      else {
        re += `[${glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else {
      re += ch.replace(/[.+^$()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function normalizeInput(input: GlobToolInput): GlobToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("glob input must be an object");
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const { pattern, path: inputPath } = rawInput;

  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("glob requires a non-empty string pattern");
  }

  if (inputPath !== undefined && typeof inputPath !== "string") {
    throw new Error("glob path must be a string when provided");
  }

  return {
    pattern,
    path: inputPath as string | undefined,
  };
}

interface ProcessError {
  code?: number | string;
}

function isProcessError(error: unknown): error is ProcessError {
  return typeof error === "object" && error !== null && "code" in error;
}
