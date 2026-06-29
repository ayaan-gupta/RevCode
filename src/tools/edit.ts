/**
 * Tool: apply a targeted edit to an existing file.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { generateDiff } from "../utils/diff.js";

export interface EditToolInput {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

export interface EditToolOptions {
  cwd?: string;
}

export async function editFile(
  input: EditToolInput,
  options: EditToolOptions = {},
): Promise<string> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const editPath = resolvePathInsideCwd(normalizedInput.path, cwd);
  const relativePath = formatRelativePath(editPath, cwd);
  const stat = await fs.stat(editPath);

  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${relativePath}`);
  }

  const oldContent = await fs.readFile(editPath, "utf8");
  let newContent = oldContent;

  for (const edit of normalizedInput.edits) {
    const occurrences = countOccurrences(newContent, edit.oldText);
    if (occurrences === 0) {
      throw new Error(`Edit target not found in ${relativePath}`);
    }

    if (occurrences > 1) {
      throw new Error(`Edit target is not unique in ${relativePath}`);
    }

    newContent = newContent.replace(edit.oldText, edit.newText);
  }

  await fs.writeFile(editPath, newContent, "utf8");
  return generateDiff(oldContent, newContent, relativePath);
}

function normalizeInput(input: EditToolInput): EditToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("edit_file input must be an object");
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const { path: inputPath, edits } = rawInput;

  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("edit_file requires a non-empty string path");
  }

  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("edit_file requires at least one edit");
  }

  return {
    path: inputPath,
    edits: edits.map((edit) => normalizeEdit(edit)),
  };
}

function normalizeEdit(edit: unknown): { oldText: string; newText: string } {
  if (typeof edit !== "object" || edit === null) {
    throw new Error("edit_file edits must be objects");
  }

  const rawEdit = edit as Record<string, unknown>;
  const { oldText, newText } = rawEdit;

  if (typeof oldText !== "string" || oldText.length === 0) {
    throw new Error("edit_file edit oldText must be a non-empty string");
  }

  if (typeof newText !== "string") {
    throw new Error("edit_file edit newText must be a string");
  }

  return { oldText, newText };
}

function resolvePathInsideCwd(inputPath: string, cwd: string): string {
  const resolved = path.resolve(cwd, inputPath);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the working directory: ${inputPath}`);
  }

  return resolved;
}

function countOccurrences(content: string, target: string): number {
  let count = 0;
  let index = 0;

  while (true) {
    index = content.indexOf(target, index);
    if (index === -1) {
      return count;
    }

    count += 1;
    index += target.length;
  }
}

function formatRelativePath(filePath: string, cwd: string): string {
  return path.relative(cwd, filePath) || ".";
}
