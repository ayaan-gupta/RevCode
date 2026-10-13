/**
 * Tool: write content to a file.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { generateDiff } from "../utils/diff.js";
import { ANCHOR_PREFIX } from "./anchored/hashline.js";
import type { ToolDefinition } from "./index.js";
import { resolvePathInsideCwd } from "./path.js";
import { decodeText, displayPath, isBinary, MAX_EDIT_FILE_BYTES } from "./read.js";

export interface WriteToolInput {
  path: string;
  content: string;
}

export interface WriteToolOutput {
  path: string;
  bytesWritten: number;
  created: boolean;
  diff: string;
  /** Set when the harness adjusted the content (preserved CRLF/BOM, stripped anchors). */
  note?: string;
}

export interface WriteToolOptions {
  cwd?: string;
  /** Allow paths outside the working directory. */
  unrestricted?: boolean;
}

/** Diff lines returned to the model; a rewritten file is already in its own context. */
const WRITE_DIFF_LINES = 150;

export async function writeFile(
  input: WriteToolInput,
  options: WriteToolOptions = {},
): Promise<WriteToolOutput> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const writePath = resolvePathInsideCwd(normalizedInput.path, cwd, options.unrestricted);
  const shownPath = displayPath(writePath, cwd);

  const existing = await readExistingFile(writePath, shownPath);
  const notes: string[] = [];

  let content = normalizedInput.content;
  const stripped = stripAnchorPrefixes(content);
  if (stripped !== undefined) {
    content = stripped;
    notes.push("Removed LINE#ID: prefixes copied from read_file output; they are not file content.");
  }

  // The model sees LF text without a BOM, so a plain rewrite of a CRLF/BOM file
  // would silently convert every line. Keep the file's own framing.
  if (existing?.decoded !== undefined) {
    const { eol, mixed, bom } = existing.decoded;
    if (eol === "\r\n" && !mixed && !content.includes("\r")) {
      content = content.replace(/\n/g, "\r\n");
      notes.push("Kept the file's CRLF line endings.");
    }
    if (bom && content.charCodeAt(0) !== 0xfeff) {
      content = `\uFEFF${content}`;
      notes.push("Kept the file's UTF-8 BOM.");
    }
  }

  await writeTextFile(writePath, content);

  const previous = existing?.decoded?.original ?? "";
  const diff = existing && existing.decoded === undefined
    ? "(previous content was binary or too large to diff)"
    : generateDiff(previous, content.charCodeAt(0) === 0xfeff ? content.slice(1) : content, shownPath, {
        maxLines: WRITE_DIFF_LINES,
      });

  return {
    path: shownPath,
    bytesWritten: Buffer.byteLength(content, "utf8"),
    created: existing === null,
    diff,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

/** Create parent directories and write `content`, keeping the mode of an existing file. */
export async function writeTextFile(absolutePath: string, content: string): Promise<void> {
  const directory = path.dirname(absolutePath);
  try {
    await fs.mkdir(directory, { recursive: true });
  } catch (error) {
    if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTDIR")) {
      throw new Error(`Cannot create directory ${directory}: a path component is an existing file.`);
    }
    throw error;
  }
  // Writing in place (not temp file + rename) preserves permissions, ownership,
  // hard links and symlinks.
  await fs.writeFile(absolutePath, content, "utf8");
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

/** If every line carries a `N#ID:` anchor prefix, the model pasted a read_file view. */
function stripAnchorPrefixes(content: string): string | undefined {
  if (content.length === 0) return undefined;
  const hasFinalNewline = content.endsWith("\n");
  const lines = (hasFinalNewline ? content.slice(0, -1) : content).split("\n");
  if (!lines.every((line) => ANCHOR_PREFIX.test(line))) return undefined;
  return lines.map((line) => line.replace(ANCHOR_PREFIX, "")).join("\n") + (hasFinalNewline ? "\n" : "");
}

interface ExistingFile {
  /** Undefined when the file is binary or too large to diff. */
  decoded?: ReturnType<typeof decodeText>;
}

async function readExistingFile(filePath: string, shownPath: string): Promise<ExistingFile | null> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory: ${shownPath}. write_file needs a file path.`);
    }
    if (!stat.isFile()) {
      throw new Error(`Path is not a regular file: ${shownPath}`);
    }
    if (stat.size > MAX_EDIT_FILE_BYTES) {
      return {};
    }

    const buffer = await fs.readFile(filePath);
    if (isBinary(buffer)) {
      return {};
    }
    return { decoded: decodeText(buffer.toString("utf8")) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export const writeToolDefinition: ToolDefinition = {
  name: "write_file",
  description:
    "Create a file or completely overwrite one with UTF-8 text, creating parent directories as needed. Pass the COMPLETE file content in one call; to change part of an existing file use the edit tool instead. An existing file's CRLF line endings and BOM are preserved. Returns metadata and a unified diff against the previous content. Refuses directories.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to write, relative to the agent working directory.",
      },
      content: {
        type: "string",
        description: "Complete UTF-8 text content to write to the file.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};
