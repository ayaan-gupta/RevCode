/**
 * Tool: read a file from the working directory.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadToolOutput {
  content: string;
  path: string;
  totalLines: number;
}

export interface ReadToolOptions {
  cwd?: string;
}

export async function readFile(
  input: ReadToolInput,
  options: ReadToolOptions = {},
): Promise<ReadToolOutput> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const readPath = resolvePathInsideCwd(normalizedInput.path, cwd);

  if (await isIgnoredByGit(readPath, cwd)) {
    throw new Error(`Refusing to read ignored file: ${formatRelativePath(readPath, cwd)}`);
  }

  const stat = await fs.stat(readPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${formatRelativePath(readPath, cwd)}`);
  }

  const buffer = await fs.readFile(readPath);
  if (isBinary(buffer)) {
    return {
      content: "[binary file omitted]",
      path: formatRelativePath(readPath, cwd),
      totalLines: 0,
    };
  }

  const text = buffer.toString("utf8");
  const lines = splitLines(text);
  const selectedLines = selectLines(lines, normalizedInput.offset, normalizedInput.limit);

  return {
    content:
      lines.length === 0
        ? "File is empty."
        : selectedLines.map(({ number, value }) => `${number}|${value}`).join("\n"),
    path: formatRelativePath(readPath, cwd),
    totalLines: lines.length,
  };
}

function normalizeInput(input: ReadToolInput): ReadToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("read_file input must be an object");
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const { path: inputPath, offset, limit } = rawInput;

  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("read_file requires a non-empty string path");
  }

  if (offset !== undefined && !Number.isInteger(offset)) {
    throw new Error("read_file offset must be an integer when provided");
  }

  if (limit !== undefined && !Number.isInteger(limit)) {
    throw new Error("read_file limit must be an integer when provided");
  }

  return {
    path: inputPath,
    offset: offset as number | undefined,
    limit: limit as number | undefined,
  };
}

function resolvePathInsideCwd(inputPath: string, cwd: string): string {
  const resolved = path.resolve(cwd, inputPath);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the working directory: ${inputPath}`);
  }

  return resolved;
}

async function isIgnoredByGit(filePath: string, cwd: string): Promise<boolean> {
  const relativePath = formatRelativePath(filePath, cwd);

  try {
    await execFileAsync("git", ["check-ignore", "--quiet", "--no-index", "--", relativePath], {
      cwd,
    });
    return true;
  } catch (error) {
    if (isProcessError(error) && error.code === 1) {
      return false;
    }

    return false;
  }
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) {
    return true;
  }

  let controlCharacters = 0;
  for (const byte of sample) {
    const isAllowedWhitespace = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !isAllowedWhitespace) {
      controlCharacters += 1;
    }
  }

  return sample.length > 0 && controlCharacters / sample.length > 0.1;
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function selectLines(
  lines: string[],
  offset?: number,
  limit?: number,
): Array<{ number: number; value: string }> {
  const start = normalizeOffset(offset, lines.length);
  const end = normalizeLimit(start, limit, lines.length);

  return lines.slice(start, end).map((value, index) => ({
    number: start + index + 1,
    value,
  }));
}

function normalizeOffset(offset: number | undefined, totalLines: number): number {
  if (offset === undefined) {
    return 0;
  }

  if (!Number.isInteger(offset) || offset === 0) {
    throw new Error("read_file offset must be a non-zero integer when provided");
  }

  if (offset > 0) {
    return Math.min(offset - 1, totalLines);
  }

  return Math.max(totalLines + offset, 0);
}

function normalizeLimit(start: number, limit: number | undefined, totalLines: number): number {
  if (limit === undefined) {
    return totalLines;
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("read_file limit must be a non-negative integer when provided");
  }

  return Math.min(start + limit, totalLines);
}

function formatRelativePath(filePath: string, cwd: string): string {
  return path.relative(cwd, filePath) || ".";
}

interface ProcessError {
  code?: number | string;
}

function isProcessError(error: unknown): error is ProcessError {
  return typeof error === "object" && error !== null && "code" in error;
}
