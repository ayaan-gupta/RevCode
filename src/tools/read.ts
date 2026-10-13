/**
 * Tool: read a file from the working directory.
 *
 * This module also owns the text-file primitives shared by every file tool:
 * decoding (BOM, CRLF), binary/UTF-8 validation, and "did you mean" suggestions
 * for missing paths. Keeping them here means edit_file, apply_patch,
 * edit_anchored and write_file all treat a file's bytes the same way.
 *
 * The "Did you mean" suggestions and the continuation notice follow the
 * conventions of sst/opencode's read tool (MIT, Copyright (c) 2025 opencode);
 * the implementation is independent. See THIRD_PARTY_NOTICES.md.
 */

import { execFile } from "node:child_process";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { diffLineBlocks, levenshtein } from "../utils/diff.js";
import { formatLineTag } from "./anchored/hashline.js";
import type { ToolDefinition } from "./index.js";
import { resolvePathInsideCwd } from "./path.js";

const execFileAsync = promisify(execFile);

/** Lines returned when the caller gives no limit. */
export const DEFAULT_READ_LIMIT = 2_000;
/** Longer lines are cut so one minified file cannot flood the context. */
export const MAX_LINE_CHARS = 2_000;
/** Output cap per read; the continuation notice says where to resume. */
export const MAX_READ_BYTES = 50 * 1024;
/** Whole-file reads above this are refused (use shell tools for slices). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Edit tools load the whole file into memory, so they cap lower. */
export const MAX_EDIT_FILE_BYTES = 16 * 1024 * 1024;

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadToolOutput {
  content: string;
  path: string;
  totalLines: number;
  /** Set when the output is partial: says how to read the rest. */
  continuation?: string;
  /** Extra information for the model (truncated lines, binary files). */
  note?: string;
}

export interface ReadToolOptions {
  cwd?: string;
  /** Allow paths outside cwd and git-ignored files. */
  unrestricted?: boolean;
  /** Render `LINE#ID:content` rows (anchored edit mode) instead of `N|content`. */
  anchors?: boolean;
}

export async function readFile(
  input: ReadToolInput,
  options: ReadToolOptions = {},
): Promise<ReadToolOutput> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const unrestricted = options.unrestricted ?? false;
  const readPath = resolvePathInsideCwd(normalizedInput.path, cwd, unrestricted);
  const displayName = displayPath(readPath, cwd);

  if (!unrestricted && (await isIgnoredByGit(readPath, cwd))) {
    throw new Error(`Refusing to read ignored file: ${displayName}`);
  }

  const stat = await statOrExplain(readPath, cwd);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory: ${displayName}. Use list_directory to see its contents.`);
  }
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${displayName}`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large to read (${formatBytes(stat.size)}): ${displayName}. Read a slice with the shell instead, e.g. sed -n '1,200p' or head/tail, or search it with grep.`,
    );
  }

  const buffer = await fs.readFile(readPath);
  if (isBinary(buffer)) {
    return {
      content: "[binary file omitted]",
      path: displayName,
      totalLines: 0,
      note: `${formatBytes(buffer.length)} of binary data. Inspect it with shell tools (file, xxd, strings) if needed.`,
    };
  }

  // The BOM is invisible framing, not content (edit tools hide it too).
  const lines = splitLines(decodeText(buffer.toString("utf8")).original);
  const total = lines.length;
  if (total === 0) {
    return { content: "File is empty.", path: displayName, totalLines: 0 };
  }

  const start = normalizeOffset(normalizedInput.offset, total);
  if (start >= total) {
    return {
      content: "",
      path: displayName,
      totalLines: total,
      continuation: `[Offset ${normalizedInput.offset} is past the end of the file (${total} line${total === 1 ? "" : "s"}). Use an offset between 1 and ${total}, or a negative offset to read from the end.]`,
    };
  }
  const requestedEnd = normalizeLimit(start, normalizedInput.limit, total);

  const rendered: string[] = [];
  const truncatedLines: number[] = [];
  let bytes = 0;
  let cappedByBytes = false;
  for (let index = start; index < requestedEnd; index += 1) {
    const { text, truncated } = clipLine(lines[index]);
    const row = options.anchors
      ? `${formatLineTag(index + 1, lines[index])}:${text}`
      : `${index + 1}|${text}`;
    const size = Buffer.byteLength(row, "utf8") + 1;
    if (rendered.length > 0 && bytes + size > MAX_READ_BYTES) {
      cappedByBytes = true;
      break;
    }
    bytes += size;
    rendered.push(row);
    if (truncated) {
      truncatedLines.push(index + 1);
    }
  }

  const shownEnd = start + rendered.length;
  const result: ReadToolOutput = {
    content: rendered.join("\n"),
    path: displayName,
    totalLines: total,
  };
  if (shownEnd < total && rendered.length > 0) {
    const reason = cappedByBytes ? ` (${formatBytes(MAX_READ_BYTES)} output limit)` : "";
    result.continuation = `[Showing lines ${start + 1}-${shownEnd} of ${total}${reason}. Continue with offset: ${shownEnd + 1}]`;
  }
  if (truncatedLines.length > 0) {
    const listed = truncatedLines.slice(0, 5).join(", ");
    const more = truncatedLines.length > 5 ? ` and ${truncatedLines.length - 5} more` : "";
    result.note = `Line${truncatedLines.length === 1 ? "" : "s"} ${listed}${more} exceeded ${MAX_LINE_CHARS} characters and ${truncatedLines.length === 1 ? "was" : "were"} cut. Use grep or shell tools (cut, awk) to inspect the rest.`;
  }
  return result;
}

function normalizeInput(input: ReadToolInput): ReadToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("read_file input must be an object");
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const { path: inputPath } = rawInput;
  // Models often send null for optional arguments.
  const offset = rawInput.offset ?? undefined;
  const limit = rawInput.limit ?? undefined;

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

function clipLine(line: string): { text: string; truncated: boolean } {
  if (line.length <= MAX_LINE_CHARS) {
    return { text: line, truncated: false };
  }
  const hidden = line.length - MAX_LINE_CHARS;
  return { text: `${line.slice(0, MAX_LINE_CHARS)}… [${hidden} more characters]`, truncated: true };
}

function normalizeOffset(offset: number | undefined, totalLines: number): number {
  if (offset === undefined) {
    return 0;
  }

  if (!Number.isInteger(offset) || offset === 0) {
    throw new Error("read_file offset must be a non-zero integer when provided");
  }

  if (offset > 0) {
    return offset - 1;
  }

  return Math.max(totalLines + offset, 0);
}

function normalizeLimit(start: number, limit: number | undefined, totalLines: number): number {
  if (limit === undefined) {
    return Math.min(start + DEFAULT_READ_LIMIT, totalLines);
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("read_file limit must be a non-negative integer when provided");
  }

  return Math.min(start + limit, totalLines);
}

async function isIgnoredByGit(filePath: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "--quiet", "--no-index", "--", path.relative(cwd, filePath) || "."], {
      cwd,
    });
    return true;
  } catch {
    // Exit 1 means "not ignored"; anything else (no git, not a repo) means we cannot tell.
    return false;
  }
}

export function isBinary(buffer: Uint8Array): boolean {
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

// --- shared text-file primitives ---------------------------------------------

export type LineEnding = "\n" | "\r\n";

/** A text file split into the content tools edit and the framing they must preserve. */
export interface DecodedText {
  /** Content without BOM and with every CRLF turned into LF. */
  text: string;
  bom: boolean;
  /** Dominant line ending; new lines are written with it. */
  eol: LineEnding;
  /** The file mixes CRLF and bare LF; per-line endings are restored by alignment. */
  mixed: boolean;
  /** Original content without BOM (needed to restore mixed endings). */
  original: string;
}

export function decodeText(raw: string): DecodedText {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const original = bom ? raw.slice(1) : raw;
  const crlf = (original.match(/\r\n/g) ?? []).length;
  const lf = (original.match(/\n/g) ?? []).length - crlf;
  return {
    text: crlf > 0 ? original.replace(/\r\n/g, "\n") : original,
    bom,
    eol: crlf > 0 && crlf >= lf ? "\r\n" : "\n",
    mixed: crlf > 0 && lf > 0,
    original,
  };
}

/** Turn LF `text` (an edited version of `decoded.text`) back into the file's own framing. */
export function encodeText(decoded: DecodedText, text: string): string {
  let body = text;
  if (decoded.mixed) {
    body = restoreMixedEndings(decoded, text);
  } else if (decoded.eol === "\r\n") {
    body = text.replace(/\n/g, "\r\n");
  }
  return decoded.bom ? `\uFEFF${body}` : body;
}

/**
 * Give unchanged lines their original ending. A replaced line inherits the
 * ending of the line it replaced; inserted lines take the ending of the line
 * above them (the dominant ending at the top of the file).
 */
function restoreMixedEndings(decoded: DecodedText, text: string): string {
  const oldEnds = decoded.original.match(/\r?\n/g) ?? [];
  const oldParts = decoded.text.split("\n");
  const newParts = text.split("\n");
  const blocks = diffLineBlocks(oldParts, newParts);

  const ends = new Array<string>(newParts.length).fill(decoded.eol);
  let oldIndex = 0;
  let newIndex = 0;
  const carry = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      ends[newIndex + i] = oldEnds[oldIndex + i] ?? decoded.eol;
    }
    oldIndex += count;
    newIndex += count;
  };
  for (const block of blocks) {
    carry(block.oldStart - oldIndex);
    const replaced = block.oldEnd - block.oldStart;
    for (let k = 0; k < block.newEnd - block.newStart; k += 1) {
      const inherited = k < replaced ? oldEnds[block.oldStart + k] : ends[block.newStart + k - 1];
      ends[block.newStart + k] = inherited ?? decoded.eol;
    }
    oldIndex = block.oldEnd;
    newIndex = block.newEnd;
  }
  carry(oldParts.length - oldIndex);

  return newParts.map((part, i) => (i < newParts.length - 1 ? part + ends[i] : part)).join("");
}

/** Normalize model-supplied text to LF so it matches the decoded file. */
export function toLf(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n/g, "\n") : text;
}

export interface LoadedTextFile extends DecodedText {
  /** Absolute path. */
  absolutePath: string;
  /** Path as shown to the model. */
  displayPath: string;
  mode: number;
}

/**
 * Read a file for editing. Refuses directories, binary data and anything that
 * is not valid UTF-8 (writing it back would silently corrupt it). A missing
 * file produces a "did you mean" error.
 */
export async function loadTextFile(
  absolutePath: string,
  cwd: string,
  options: { verb?: string } = {},
): Promise<LoadedTextFile> {
  const verb = options.verb ?? "edit";
  const shown = displayPath(absolutePath, cwd);
  const stat = await statOrExplain(absolutePath, cwd);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${shown}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${shown}`);
  }
  if (stat.size > MAX_EDIT_FILE_BYTES) {
    throw new Error(
      `File is too large to ${verb} (${formatBytes(stat.size)}): ${shown}. Use shell tools (sed, python) for changes to very large files.`,
    );
  }

  const buffer = await fs.readFile(absolutePath);
  if (isBinary(buffer)) {
    throw new Error(`Refusing to ${verb} binary file: ${shown}`);
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error(
      `Refusing to ${verb} ${shown}: it is not valid UTF-8 (probably Latin-1 or another encoding), and rewriting it would corrupt it. Use shell tools such as iconv or python instead.`,
    );
  }
  return { ...decodeText(raw), absolutePath, displayPath: shown, mode: stat.mode };
}

/** Path as shown to the model: relative inside cwd, absolute outside it. */
export function displayPath(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (relative === "") return ".";
  return relative.startsWith("..") || path.isAbsolute(relative) ? absolutePath : relative;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- missing-file suggestions -------------------------------------------------

async function statOrExplain(absolutePath: string, cwd: string): Promise<Stats> {
  try {
    return await fs.stat(absolutePath);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new Error(await describeMissingFile(absolutePath, cwd));
    }
    throw error;
  }
}

/** "File not found" message with up to three similarly named files. */
export async function describeMissingFile(absolutePath: string, cwd: string): Promise<string> {
  const shown = displayPath(absolutePath, cwd);
  const suggestions = await suggestSimilarPaths(absolutePath, cwd);
  if (suggestions.length === 0) {
    return `File not found: ${shown}`;
  }
  return `File not found: ${shown}. Did you mean: ${suggestions.join(", ")}?`;
}

/**
 * Names in the same directory that look like a typo of the requested file
 * (case, missing extension, prefix, small edit distance). If the directory
 * itself is wrong, try the closest existing directory name one level up.
 */
export async function suggestSimilarPaths(absolutePath: string, cwd: string): Promise<string[]> {
  const parent = path.dirname(absolutePath);
  const wanted = path.basename(absolutePath);

  const direct = await rankedNames(parent, wanted);
  if (direct !== undefined) {
    return direct.map((name) => displayPath(path.join(parent, name), cwd));
  }

  // The directory does not exist: find the nearest existing ancestor and fix one segment.
  let ancestor = path.dirname(parent);
  let missing = path.basename(parent);
  let rest = wanted;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidates = await rankedNames(ancestor, missing);
    if (candidates !== undefined) {
      const found: string[] = [];
      for (const candidate of candidates) {
        const target = path.join(ancestor, candidate, rest);
        if (await exists(target)) {
          found.push(displayPath(target, cwd));
        }
      }
      return found;
    }
    rest = path.join(missing, rest);
    missing = path.basename(ancestor);
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  return [];
}

/** Ranked similar names in `directory`, or undefined if it cannot be listed. */
async function rankedNames(directory: string, wanted: string): Promise<string[] | undefined> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return undefined;
  }
  const lower = wanted.toLowerCase();
  const stem = lower.replace(/\.[^./]+$/, "");
  const scored: Array<{ name: string; rank: number }> = [];
  for (const name of names) {
    if (name === wanted) continue;
    const candidate = name.toLowerCase();
    const candidateStem = candidate.replace(/\.[^./]+$/, "");
    let rank: number | undefined;
    if (candidate === lower) rank = 0;
    else if (candidateStem === stem) rank = 1;
    else if (candidate.startsWith(lower) || lower.startsWith(candidate)) rank = 2;
    else if (stem.length >= 3 && (candidate.includes(stem) || (candidateStem.length >= 3 && stem.includes(candidateStem)))) rank = 3;
    else {
      const distance = levenshtein(candidate, lower);
      if (distance <= Math.max(2, Math.floor(lower.length * 0.34))) rank = 4 + distance;
    }
    if (rank !== undefined) scored.push({ name, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return scored.slice(0, 3).map((entry) => entry.name);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

// --- tool definition ------------------------------------------------------------

/** read_file's schema; anchored mode documents the `LINE#ID:` row format instead of `N|`. */
export function readToolDefinitionFor(anchors: boolean): ToolDefinition {
  const format = anchors
    ? "Each row is `LINE#ID:text` (1-based line number, a two-letter content ID, then the line). The `LINE#ID` tag is what edit_anchored cites; it is not part of the file, so never include it in write_file content."
    : "Each row is `N|text` (1-based line number). The `N|` prefix is display only: never include it in edit_file oldText or write_file content.";
  return {
    name: "read_file",
    description: [
      "Read a text file. ",
      format,
      ` Output is capped at ${DEFAULT_READ_LIMIT} lines or ~${MAX_READ_BYTES / 1024} KB per call and lines over ${MAX_LINE_CHARS} characters are cut; when partial the result ends with "[Showing lines A-B of N. Continue with offset: B+1]", so call again with that offset instead of assuming you have seen the whole file.`,
      " Use offset and limit to page; a negative offset counts from the end (offset -50 = last 50 lines).",
      " Binary files are omitted, git-ignored files are refused, and a missing path suggests similarly named files.",
      " Not for discovery: use list_directory or glob to find files.",
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to read, relative to the agent working directory.",
        },
        offset: {
          type: "integer",
          description:
            "Optional 1-based line number to start reading from. Negative values count back from the end of the file.",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description: `Optional maximum number of lines to return (default ${DEFAULT_READ_LIMIT}).`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

export const readToolDefinition: ToolDefinition = readToolDefinitionFor(false);
