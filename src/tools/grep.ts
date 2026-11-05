/**
 * Tool: search file contents with ripgrep.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { formatRelativePath, resolvePathInsideCwd } from "./path.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 20_000;

export interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  context?: number;
  head_limit?: number;
}

export interface GrepToolOutput {
  matches: string;
  exitCode: number;
}

export interface GrepToolOptions {
  cwd?: string;
  /** Allow paths outside the working directory. */
  unrestricted?: boolean;
  /** ripgrep binary (tests point this at a missing one to exercise the fallback). */
  rg?: string;
}

/** Directories plain `grep -r` would otherwise wade through (ripgrep skips them via .gitignore). */
const FALLBACK_SKIP_DIRS = [".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", ".cache"];

export async function grepFiles(
  input: GrepToolInput,
  options: GrepToolOptions = {},
): Promise<GrepToolOutput> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const searchPath = resolvePathInsideCwd(normalizedInput.path ?? ".", cwd, options.unrestricted);
  const args = ["--no-heading", "--line-number", "--color=never", normalizedInput.pattern];

  if (normalizedInput.glob) {
    args.push("--glob", normalizedInput.glob);
  }

  if (normalizedInput.context !== undefined) {
    args.push("-C", String(normalizedInput.context));
  }

  if (normalizedInput.head_limit !== undefined) {
    args.push("--max-count", String(normalizedInput.head_limit));
  }

  args.push("--", searchPath);

  try {
    const { stdout, stderr } = await execFileAsync(options.rg ?? "rg", args, {
      cwd,
      maxBuffer: MAX_OUTPUT_CHARS * 2,
    });
    const output = truncateOutput([stdout, stderr].filter(Boolean).join("\n").trim() || "(no matches)");
    return { matches: output, exitCode: 0 };
  } catch (error) {
    if (isProcessError(error) && error.code === 1) {
      return { matches: "(no matches)", exitCode: 1 };
    }
    if (isProcessError(error) && error.code === "ENOENT") {
      return grepFallback(normalizedInput, searchPath, cwd);
    }

    if (isProcessError(error) && typeof error.stdout === "string") {
      const output = truncateOutput(
        [error.stdout, error.stderr].filter(Boolean).join("\n").trim() || "(no matches)",
      );
      return { matches: output, exitCode: typeof error.code === "number" ? error.code : 1 };
    }

    throw new Error(
      `grep failed for ${formatRelativePath(searchPath, cwd)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** ripgrep isn't installed: plain `grep -r`, same output shape. */
async function grepFallback(input: GrepToolInput, searchPath: string, cwd: string): Promise<GrepToolOutput> {
  const args = ["-r", "-n", "-I", "-E", ...FALLBACK_SKIP_DIRS.map((dir) => `--exclude-dir=${dir}`)];
  if (input.glob) args.push(`--include=${input.glob.replace(/^\*\*\//, "")}`);
  if (input.context !== undefined) args.push("-C", String(input.context));
  if (input.head_limit !== undefined) args.push("-m", String(input.head_limit));
  args.push("--", input.pattern, path.relative(cwd, searchPath) || ".");
  try {
    const { stdout } = await execFileAsync("grep", args, { cwd, maxBuffer: MAX_OUTPUT_CHARS * 4 });
    return { matches: truncateOutput(stdout.trim().replace(/^\.\//gm, "") || "(no matches)"), exitCode: 0 };
  } catch (error) {
    if (isProcessError(error) && error.code === 1) return { matches: "(no matches)", exitCode: 1 };
    const detail = isProcessError(error) && typeof error.stderr === "string" && error.stderr ? error.stderr.trim() : error instanceof Error ? error.message : String(error);
    throw new Error(`grep failed for ${formatRelativePath(searchPath, cwd)}: ${detail}`);
  }
}

function normalizeInput(input: GrepToolInput): GrepToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("grep input must be an object");
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const { pattern, path: inputPath, glob, context, head_limit } = rawInput;

  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("grep requires a non-empty string pattern");
  }

  if (inputPath !== undefined && typeof inputPath !== "string") {
    throw new Error("grep path must be a string when provided");
  }

  if (glob !== undefined && typeof glob !== "string") {
    throw new Error("grep glob must be a string when provided");
  }

  if (context !== undefined && !Number.isInteger(context)) {
    throw new Error("grep context must be an integer when provided");
  }

  if (head_limit !== undefined && !Number.isInteger(head_limit)) {
    throw new Error("grep head_limit must be an integer when provided");
  }

  return {
    pattern,
    path: inputPath as string | undefined,
    glob: glob as string | undefined,
    context: context as number | undefined,
    head_limit: head_limit as number | undefined,
  };
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }

  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
}

interface ProcessError {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

function isProcessError(error: unknown): error is ProcessError {
  return typeof error === "object" && error !== null && "code" in error;
}
