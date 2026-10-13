/**
 * Tool: write content to a file.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { generateDiff } from "../utils/diff.js";

export interface WriteToolInput {
  path: string;
  content: string;
}

export interface WriteToolOutput {
  path: string;
  bytesWritten: number;
  created: boolean;
  diff: string;
}

export interface WriteToolOptions {
  cwd?: string;
  /** Allow paths outside the working directory. */
  unrestricted?: boolean;
}

export async function writeFile(
  input: WriteToolInput,
  options: WriteToolOptions = {},
): Promise<WriteToolOutput> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const writePath = resolvePathInsideCwd(normalizedInput.path, cwd, options.unrestricted);
  const relativePath = formatRelativePath(writePath, cwd);

  const existingContent = await readExistingFile(writePath, relativePath);
  await fs.mkdir(path.dirname(writePath), { recursive: true });
  await fs.writeFile(writePath, normalizedInput.content, "utf8");

  return {
    path: relativePath,
    bytesWritten: Buffer.byteLength(normalizedInput.content, "utf8"),
    created: existingContent === null,
    diff: generateDiff(existingContent ?? "", normalizedInput.content, relativePath),
  };
}

function normalizeInput(input: WriteToolInput): WriteToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("write_file input must be an object");
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const { path: inputPath, content } = rawInput;

  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("write_file requires a non-empty string path");
  }

  if (typeof content !== "string") {
    throw new Error("write_file requires string content");
  }

  return {
    path: inputPath,
    content,
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

async function readExistingFile(filePath: string, relativePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${relativePath}`);
    }

    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function formatRelativePath(filePath: string, cwd: string): string {
  return path.relative(cwd, filePath) || ".";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
