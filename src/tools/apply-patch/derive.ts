/**
 * Compute a file's new contents from parsed update chunks.
 *
 * Adapted from openai/codex (codex-rs/apply-patch/src/{file_update,text_file}.rs),
 * Apache-2.0, Copyright 2025 OpenAI. See THIRD_PARTY_NOTICES.md.
 *
 * Modified for RevCode:
 *  - nested `@@` contexts are searched in order;
 *  - a hunk that matches several places without a distinguishing `@@` context
 *    produces a warning (Codex silently takes the first);
 *  - a pure-insertion hunk that names a context line inserts right after it
 *    (Codex appends at the end of the file regardless);
 *  - a file without a final newline stays that way (Codex always adds one);
 *  - a failed hunk reports the closest text in the file.
 */

import { findClosestLines } from "../../utils/diff.js";
import type { Chunk } from "./parse.js";
import { PatchError } from "./parse.js";
import { seekAll } from "./seek.js";

interface SourceLine {
  text: string;
  /** "\n", "\r\n", "\r", or "" for an unterminated last line. */
  end: string;
}

type Replacement = [start: number, deleteCount: number, insert: string[]];

export interface DerivedContents {
  content: string;
  warnings: string[];
}

function splitSource(original: string): SourceLine[] {
  const lines: SourceLine[] = [];
  for (const match of original.matchAll(/([^\r\n]*)(\r\n|\r|\n)|([^\r\n]+)$/g)) {
    lines.push({ text: match[1] ?? match[3], end: match[2] ?? "" });
  }
  return lines;
}

/** Apply `chunks` to `original` (without BOM) and return the new contents. */
export function deriveNewContents(original: string, chunks: readonly Chunk[], path: string): DerivedContents {
  const source = splitSource(original);
  const preferredEnd = source.find((line) => line.end !== "")?.end ?? "\n";
  const lines = source.map((line) => line.text);
  const replacements: Replacement[] = [];
  const warnings: string[] = [];
  let cursor = 0;

  chunks.forEach((chunk, chunkIndex) => {
    const label = chunks.length > 1 ? `hunk ${chunkIndex + 1} of ${path}` : `the hunk for ${path}`;
    let anchored = false;
    for (const context of chunk.contexts) {
      const matches = seekAll(lines, [context], cursor, false);
      if (matches.length === 0) {
        throw new PatchError(`Failed to find context '${context}' in ${path}`);
      }
      if (matches.length > 1) {
        warnings.push(
          `In ${label}: context '${context}' appears at lines ${listLines(matches)}; used line ${matches[0] + 1}. Add another @@ line or more context lines if that is the wrong place.`,
        );
      }
      cursor = matches[0] + 1;
      anchored = true;
    }

    if (chunk.oldLines.length === 0) {
      // Nothing to match: insert after the named context line, else at the end of the file.
      replacements.push([anchored ? cursor : lines.length, 0, chunk.newLines]);
      return;
    }

    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let matches = seekAll(lines, oldLines, cursor, chunk.isEndOfFile);
    // A trailing "" stands for the file's final newline, which is not a line here.
    if (matches.length === 0 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      matches = seekAll(lines, oldLines, cursor, chunk.isEndOfFile);
    }
    if (matches.length === 0) {
      throw new PatchError(describeMiss(path, lines, chunk));
    }

    const at = matches[0];
    if (matches.length > 1 && !anchored && !chunk.isEndOfFile) {
      warnings.push(
        `In ${label}: the context matched ${matches.length} places (lines ${listLines(matches)}); applied at line ${at + 1}. Add an @@ line naming the enclosing function or class, or more context lines, if that is the wrong place.`,
      );
    }

    // Split around context rows so those lines keep their exact original bytes.
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextIndices) {
      if (oldContext >= oldLines.length || newContext >= newLines.length) break;
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([at + oldStart, oldContext - oldStart, newLines.slice(newStart, newContext)]);
      }
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== oldLines.length || newStart !== newLines.length) {
      replacements.push([at + oldStart, oldLines.length - oldStart, newLines.slice(newStart)]);
    }
    cursor = at + oldLines.length;
  });

  replacements.sort((a, b) => a[0] - b[0]);
  const out: SourceLine[] = [];
  let position = 0;
  for (const [start, deleteCount, insert] of replacements) {
    while (position < start) out.push(source[position++]);
    position += deleteCount;
    for (const text of insert) out.push({ text, end: preferredEnd });
  }
  while (position < source.length) out.push(source[position++]);

  // Every line but possibly the last needs a terminator; the file keeps its
  // final-newline state (a new or emptied file ends with one).
  const keepsFinalNewline = source.length === 0 || source[source.length - 1].end !== "";
  const content = out
    .map((line, index) => {
      const isLast = index === out.length - 1;
      if (isLast && !keepsFinalNewline) return line.text;
      return line.text + (line.end || preferredEnd);
    })
    .join("");
  return { content, warnings };
}

function listLines(matches: readonly number[]): string {
  const shown = matches.slice(0, 5).map((index) => index + 1).join(", ");
  return matches.length > 5 ? `${shown}, ...` : shown;
}

function describeMiss(path: string, lines: readonly string[], chunk: Chunk): string {
  const message = [`Failed to find expected lines in ${path}:`, chunk.oldLines.join("\n")];
  const closest = findClosestLines(lines, chunk.oldLines);
  if (closest !== null && closest.score >= 0.5) {
    const clip = (text: string): string => (text.length > 120 ? `${text.slice(0, 120)}…` : text);
    message.push(
      `Closest match in the file (${Math.round(closest.score * 100)}% similar) at line ${closest.line}:`,
      `- ${clip(closest.expected)}`,
      `+ ${clip(closest.actual)}`,
    );
  }
  message.push("Re-read the file and copy context and '-' lines exactly; add an @@ line if the snippet is not unique.");
  return message.join("\n");
}
