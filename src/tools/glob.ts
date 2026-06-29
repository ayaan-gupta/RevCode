/**
 * Tool: find files by glob pattern.
 */

import { execFile } from "node:child_process";
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
}

export async function globFiles(
  input: GlobToolInput,
  options: GlobToolOptions = {},
): Promise<GlobToolOutput> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const searchPath = resolvePathInsideCwd(normalizedInput.path ?? ".", cwd);
  const relativeSearchPath = formatRelativePath(searchPath, cwd);

  const args = ["--files", "-g", normalizedInput.pattern, relativeSearchPath];

  try {
    const { stdout } = await execFileAsync("rg", args, { cwd });
    const matches = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_RESULTS);

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
