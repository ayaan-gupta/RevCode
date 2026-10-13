/**
 * Hashline: line-addressed edits with content-hash staleness checks.
 *
 * Adapted from can1357/oh-my-pi (MIT), packages/coding-agent/src/patch/hashline.ts
 * at tag v13.0.0. Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük,
 * (c) 2026 Stencil Labs, Inc. See THIRD_PARTY_NOTICES.md.
 *
 * Modified for RevCode:
 *  - dependency-free xxHash32 instead of Bun.hash;
 *  - bottom-up application keyed by the splice index. The upstream key (the
 *    last line of a replace, the `after` line of an append) misplaces an
 *    `append after N` issued together with a range ending at N;
 *  - overlapping edits are rejected instead of silently corrupting the file;
 *  - the empty string after a final newline is not an addressable line, so
 *    "append at end of file" keeps the trailing newline;
 *  - edits operate on LF text; the tool layer restores CRLF/BOM.
 *
 * Every line shown to the model is tagged `LINE#ID:content`. `ID` is two letters
 * derived from the line's content (whitespace-insensitive), so a tag is both an
 * address and a staleness check: if the line changed since it was read the edit
 * is rejected before anything is mutated, and the error carries the current
 * tags so the model can retry without another read.
 */

import { xxh32 } from "./xxh32.js";

/** 16 distinct consonants: not digits, not hex, so IDs cannot be confused with line numbers or content. */
const NIBBLE = "ZPMQVRWSNKTXJBYH";
const ID_PATTERN = `[${NIBBLE}]{2}`;
const TAG_PATTERN = new RegExp(`^\\s*[>+-]*\\s*(\\d+)\\s*#\\s*(${ID_PATTERN})`);
/** `12#QX:` at the start of a line: an anchor copied from a read_file view. */
export const ANCHOR_PREFIX = new RegExp(`^\\s*\\d+#${ID_PATTERN}:`);
/** Lines of context shown around each stale tag. */
const MISMATCH_CONTEXT = 2;

export interface LineTag {
  line: number;
  hash: string;
}

export type HashlineEdit =
  | { op: "replace"; tag: string; content?: string[] | null }
  | { op: "replace"; first: string; last: string; content?: string[] | null }
  | { op: "append"; after?: string; content: string[] }
  | { op: "prepend"; before?: string; content: string[] }
  | { op: "insert"; after: string; before: string; content: string[] };

/** Two-letter content ID for a line. Whitespace and a trailing CR do not matter. */
export function lineId(line: string): string {
  const hash = xxh32(line.replace(/\s+/g, "")) & 0xff;
  return NIBBLE[hash >>> 4] + NIBBLE[hash & 0x0f];
}

/** `12#QX`: the reference a model cites to address a line. */
export function formatLineTag(lineNumber: number, line: string): string {
  return `${lineNumber}#${lineId(line)}`;
}

/** `12#QX:content` as shown by read_file in anchored mode. */
export function anchorLine(lineNumber: number, line: string): string {
  return `${formatLineTag(lineNumber, line)}:${line}`;
}

/**
 * Split LF text into addressable lines. The empty string after a final newline
 * is not a line; `trailingNewline` remembers it so the file round-trips.
 */
export function splitAnchoredLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text.length === 0) {
    return { lines: [], trailingNewline: true };
  }
  const lines = text.split("\n");
  const trailingNewline = lines.at(-1) === "";
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

export function joinAnchoredLines(lines: readonly string[], trailingNewline: boolean): string {
  return lines.length === 0 ? "" : lines.join("\n") + (trailingNewline ? "\n" : "");
}

/** Render text as `LINE#ID:content` rows, numbering from `startLine`. */
export function renderAnchoredLines(content: string, startLine = 1): string {
  const { lines } = splitAnchoredLines(content.replace(/\r\n/g, "\n"));
  return lines.map((line, index) => anchorLine(startLine + index, line)).join("\n");
}

/** Parse `"5#PM"`, tolerating a copied `>>>`/`+`/`-` prefix and a trailing `:content`. */
export function parseTag(ref: string): LineTag {
  const match = TAG_PATTERN.exec(ref);
  if (!match) {
    throw new Error(`Invalid line reference "${ref}". Expected format "LINE#ID" (e.g. "5#PM"), copied exactly from read_file output.`);
  }
  const line = Number.parseInt(match[1], 10);
  if (line < 1) {
    throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
  }
  return { line, hash: match[2] };
}

export interface HashMismatch extends LineTag {
  actual: string;
}

/** Thrown when one or more tags no longer match the file. Nothing was modified. */
export class HashlineMismatchError extends Error {
  constructor(
    readonly mismatches: readonly HashMismatch[],
    fileLines: readonly string[],
  ) {
    super(HashlineMismatchError.format(mismatches, fileLines));
    this.name = "HashlineMismatchError";
  }

  private static format(mismatches: readonly HashMismatch[], fileLines: readonly string[]): string {
    const stale = new Set(mismatches.map((m) => m.line));
    const shown = new Set<number>();
    for (const mismatch of mismatches) {
      const low = Math.max(1, mismatch.line - MISMATCH_CONTEXT);
      const high = Math.min(fileLines.length, mismatch.line + MISMATCH_CONTEXT);
      for (let n = low; n <= high; n += 1) {
        shown.add(n);
      }
    }

    const count = stale.size;
    const out = [
      `${count} line${count > 1 ? "s have" : " has"} changed since last read. Use the updated LINE#ID references shown below (>>> marks changed lines).`,
      "",
    ];
    let previous = -1;
    for (const n of [...shown].sort((a, b) => a - b)) {
      if (previous !== -1 && n > previous + 1) {
        out.push("    ...");
      }
      previous = n;
      out.push(`${stale.has(n) ? ">>> " : "    "}${anchorLine(n, fileLines[n - 1])}`);
    }
    out.push("", "No edits were applied. Retry with the updated tags.");
    return out.join("\n");
  }
}

export interface NoopEdit {
  /** Position of the edit in the request (0-based). */
  editIndex: number;
  /** Tag(s) the edit targeted, e.g. `4#PN`. */
  location: string;
  currentContent: string;
}

export interface HashlineApplyResult {
  /** LF text after applying the edits. */
  content: string;
  /** Edits that would not have changed anything. */
  noops: NoopEdit[];
}

interface PlannedEdit {
  editIndex: number;
  /** 0-based splice index. */
  at: number;
  deleteCount: number;
  insert: string[];
  location: string;
}

/**
 * Apply edits to LF text. Every reference is validated against the same
 * pre-edit snapshot before anything is changed; edits are then applied bottom-up
 * so earlier splices never shift later targets.
 */
export function applyHashlineEdits(text: string, edits: readonly HashlineEdit[]): HashlineApplyResult {
  const { lines, trailingNewline } = splitAnchoredLines(text);
  if (edits.length === 0) {
    return { content: text, noops: [] };
  }

  const mismatches: HashMismatch[] = [];
  const resolve = (ref: string): LineTag => {
    const tag = parseTag(ref);
    if (tag.line > lines.length) {
      throw new Error(`Line ${tag.line} does not exist (file has ${lines.length} line${lines.length === 1 ? "" : "s"}).`);
    }
    const actual = lineId(lines[tag.line - 1]);
    if (actual !== tag.hash) {
      mismatches.push({ ...tag, actual });
    }
    return tag;
  };

  const planned: PlannedEdit[] = [];
  const seen = new Set<string>();
  edits.forEach((edit, editIndex) => {
    const key = JSON.stringify(edit);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    planned.push(plan(edit, editIndex, resolve, lines.length));
  });
  if (mismatches.length > 0) {
    throw new HashlineMismatchError(dedupeMismatches(mismatches), lines);
  }

  assertNoOverlap(planned);

  const noops: NoopEdit[] = [];
  const effective: PlannedEdit[] = [];
  for (const edit of planned) {
    const current = lines.slice(edit.at, edit.at + edit.deleteCount);
    const unchanged =
      edit.deleteCount > 0 &&
      current.length === edit.insert.length &&
      current.every((line, i) => stripCr(line) === stripCr(edit.insert[i]));
    if (unchanged) {
      noops.push({ editIndex: edit.editIndex, location: edit.location, currentContent: current.join("\n") });
    } else {
      effective.push(edit);
    }
  }

  // Highest splice index first. At one index a replace goes before inserts, and
  // inserts run in reverse request order so they end up in request order.
  effective.sort(
    (a, b) => b.at - a.at || Number(b.deleteCount > 0) - Number(a.deleteCount > 0) || b.editIndex - a.editIndex,
  );
  const next = lines.slice();
  for (const edit of effective) {
    next.splice(edit.at, edit.deleteCount, ...edit.insert);
  }
  return { content: joinAnchoredLines(next, trailingNewline || lines.length === 0), noops };
}

function plan(edit: HashlineEdit, editIndex: number, resolve: (ref: string) => LineTag, lineCount: number): PlannedEdit {
  switch (edit.op) {
    case "replace": {
      const first = resolve("tag" in edit ? edit.tag : edit.first);
      const last = "tag" in edit ? first : resolve(edit.last);
      if (last.line < first.line) {
        throw new Error(`Range start line ${first.line} must be <= end line ${last.line}`);
      }
      const location = first.line === last.line ? `${first.line}#${first.hash}` : `${first.line}#${first.hash}..${last.line}#${last.hash}`;
      return {
        editIndex,
        at: first.line - 1,
        deleteCount: last.line - first.line + 1,
        insert: normalizeContent(edit.content ?? []),
        location,
      };
    }
    case "append": {
      const insert = requireContent(edit.content, "append");
      const after = edit.after ? resolve(edit.after) : undefined;
      return {
        editIndex,
        at: after ? after.line : lineCount,
        deleteCount: 0,
        insert,
        location: after ? `${after.line}#${after.hash}` : "EOF",
      };
    }
    case "prepend": {
      const insert = requireContent(edit.content, "prepend");
      const before = edit.before ? resolve(edit.before) : undefined;
      return {
        editIndex,
        at: before ? before.line - 1 : 0,
        deleteCount: 0,
        insert,
        location: before ? `${before.line}#${before.hash}` : "BOF",
      };
    }
    case "insert": {
      const insert = requireContent(edit.content, "insert");
      const after = resolve(edit.after);
      const before = resolve(edit.before);
      if (before.line <= after.line) {
        throw new Error(`insert requires after (${after.line}) < before (${before.line})`);
      }
      return {
        editIndex,
        at: before.line - 1,
        deleteCount: 0,
        insert,
        location: `${after.line}#${after.hash}..${before.line}#${before.hash}`,
      };
    }
  }
}

function requireContent(content: string[] | undefined, op: string): string[] {
  const lines = normalizeContent(content ?? []);
  if (lines.length === 0) {
    throw new Error(`${op} requires non-empty content (an array of lines to insert).`);
  }
  return lines;
}

/**
 * Normalize model-supplied replacement lines: split embedded newlines, drop
 * carriage returns, and strip `N#ID:` prefixes if the model pasted them from a read.
 */
export function normalizeContent(content: readonly string[]): string[] {
  // Models often terminate each array element with "\n"; that is a line ending, not a blank line.
  const terminated = content.length > 0 && content.every((entry) => entry.endsWith("\n"));
  const entries = content.map((entry, index) =>
    entry.endsWith("\n") && (terminated || index === content.length - 1) ? entry.slice(0, -1) : entry,
  );
  const lines = entries.flatMap((entry) => entry.replace(/\r\n/g, "\n").split("\n"));
  const withPrefix = lines.filter((line) => ANCHOR_PREFIX.test(line)).length;
  if (lines.length > 0 && withPrefix === lines.length) {
    return lines.map((line) => line.replace(ANCHOR_PREFIX, ""));
  }
  return lines;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function dedupeMismatches(mismatches: HashMismatch[]): HashMismatch[] {
  const byLine = new Map<number, HashMismatch>();
  for (const mismatch of mismatches) {
    byLine.set(mismatch.line, mismatch);
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/** Two edits must not touch the same lines, and nothing may be inserted inside a replaced range. */
function assertNoOverlap(planned: readonly PlannedEdit[]): void {
  const ranges = planned.filter((edit) => edit.deleteCount > 0);
  for (const range of ranges) {
    const end = range.at + range.deleteCount;
    for (const other of planned) {
      if (other === range) continue;
      const conflicts =
        other.deleteCount > 0
          ? other.at < end && range.at < other.at + other.deleteCount && other.editIndex > range.editIndex
          : other.at > range.at && other.at < end;
      if (conflicts) {
        throw new Error(
          `Edits ${range.editIndex + 1} (${range.location}) and ${other.editIndex + 1} (${other.location}) overlap. Merge them into one edit that covers the whole span.`,
        );
      }
    }
  }
}

export interface RegionOptions {
  /** Context lines around each range (default 2). */
  context?: number;
  /** Maximum rows rendered (default 80). */
  maxLines?: number;
}

/**
 * Render `[start, end)` ranges (0-based, in `lines`) as anchored rows with
 * context, joining overlapping windows and separating gaps with `...`.
 */
export function renderAnchoredRegions(
  lines: readonly string[],
  ranges: ReadonlyArray<readonly [start: number, end: number]>,
  options: RegionOptions = {},
): string {
  const context = options.context ?? 2;
  const maxLines = options.maxLines ?? 80;
  const windows: Array<[number, number]> = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const from = Math.max(0, start - context);
    const to = Math.min(lines.length, Math.max(end, start) + context);
    const last = windows.at(-1);
    if (last && from <= last[1]) {
      last[1] = Math.max(last[1], to);
    } else {
      windows.push([from, to]);
    }
  }

  const out: string[] = [];
  let omitted = 0;
  for (const [from, to] of windows) {
    if (out.length > 0) out.push("...");
    for (let i = from; i < to; i += 1) {
      if (out.length >= maxLines) {
        omitted += 1;
        continue;
      }
      const text = lines[i].length > 500 ? `${lines[i].slice(0, 500)}…` : lines[i];
      out.push(`${formatLineTag(i + 1, lines[i])}:${text}`);
    }
  }
  if (omitted > 0) {
    out.push(`... (${omitted} more lines; read_file for the rest)`);
  }
  return out.join("\n");
}
