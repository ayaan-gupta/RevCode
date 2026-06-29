/**
 * Tool: delete a file within the working directory.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { formatRelativePath, resolvePathInsideCwd } from "./path.js";

const execFileAsync = promisify(execFile);

export interface DeleteToolInput {
  path: string;
}

export interface DeleteToolOutput {
  path: string;
  deleted: boolean;
}

export interface DeleteToolOptions {
  cwd?: string;
}

export async function deleteFile(
  input: DeleteToolInput,
  options: DeleteToolOptions = {},
): Promise<DeleteToolOutput> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const deletePath = resolvePathInsideCwd(normalizedInput.path, cwd);
  const relativePath = formatRelativePath(deletePath, cwd);

  if (await isIgnoredByGit(deletePath, cwd)) {
    throw new Error(`Refusing to delete ignored file: ${relativePath}`);
  }

  const stat = await fs.stat(deletePath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${relativePath}`);
  }

  await fs.unlink(deletePath);
  return { path: relativePath, deleted: true };
}

function normalizeInput(input: DeleteToolInput): DeleteToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("delete_file input must be an object");
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const inputPath = rawInput.path;

  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("delete_file requires a non-empty string path");
  }

  return { path: inputPath };
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

interface ProcessError {
  code?: number | string;
}

function isProcessError(error: unknown): error is ProcessError {
  return typeof error === "object" && error !== null && "code" in error;
}
