/**
 * Tool: list directory contents.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { formatRelativePath, resolvePathInsideCwd } from "./path.js";

export interface ListToolInput {
  path: string;
}

export interface ListToolOutput {
  path: string;
  entries: string[];
  content: string;
}

export interface ListToolOptions {
  cwd?: string;
  /** Allow paths outside the working directory. */
  unrestricted?: boolean;
}

export async function listDirectory(
  input: ListToolInput,
  options: ListToolOptions = {},
): Promise<ListToolOutput> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const listPath = resolvePathInsideCwd(normalizedInput.path, cwd, options.unrestricted);
  const relativePath = formatRelativePath(listPath, cwd);

  const stat = await fs.stat(listPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${relativePath}`);
  }

  const dirents = await fs.readdir(listPath, { withFileTypes: true });
  const entries = dirents
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort((left, right) => {
      const leftIsDir = left.endsWith("/");
      const rightIsDir = right.endsWith("/");
      if (leftIsDir !== rightIsDir) {
        return leftIsDir ? -1 : 1;
      }
      return left.localeCompare(right, undefined, { sensitivity: "base" });
    });

  const content =
    entries.length === 0
      ? `(empty directory: ${relativePath})`
      : `[${relativePath} — ${entries.length} entries]\n${entries.join("\n")}`;

  return {
    path: relativePath,
    entries,
    content,
  };
}

function normalizeInput(input: ListToolInput): ListToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("list_directory input must be an object");
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const inputPath = rawInput.path;

  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("list_directory requires a non-empty string path");
  }

  return { path: inputPath };
}
