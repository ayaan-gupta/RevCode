/**
 * Unified diff → terminal rows, with line-number gutters and add/remove shading — the view
 * you get after an edit and in the permission prompt before one.
 */

import type { Style } from "./style.js";
import { sanitizeForDisplay } from "./fmt.js";
import { padEnd, truncate, visibleWidth } from "./width.js";

export interface DiffViewOptions {
  style: Style;
  width: number;
  /** Maximum rows to return; the rest is summarized in one line. */
  maxRows: number;
  /** Name the file above its hunks even for a single-file diff (tool cards already show it). */
  showFileNames?: boolean;
}

export interface DiffView {
  rows: string[];
  added: number;
  removed: number;
  /** Diff body rows that did not fit. */
  hidden: number;
}

interface Row {
  kind: "add" | "del" | "ctx" | "sep" | "file" | "note";
  oldNo?: number;
  newNo?: number;
  text: string;
}

export function parseUnifiedDiff(diff: string): { rows: Row[]; added: number; removed: number; files: number } {
  const rows: Row[] = [];
  let added = 0;
  let removed = 0;
  let files = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let sawHunk = false;
  let oldLeft = 0;
  let newLeft = 0;

  for (const raw of sanitizeForDisplay(diff).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("--- ") && !inHunk) continue;
    if (line.startsWith("+++ ") && !inHunk) {
      files += 1;
      const name = line.slice(4).replace(/^b\//, "");
      if (name !== "/dev/null") rows.push({ kind: "file", text: name });
      sawHunk = false;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true;
      if (sawHunk) rows.push({ kind: "sep", text: "" });
      sawHunk = true;
      continue;
    }
    if (!inHunk) {
      // git's per-file preamble is noise next to the file name and the hunks
      if (/^(diff --git|index |new file mode|deleted file mode|old mode|new mode|similarity index|--- |\+\+\+ )/.test(line)) continue;
      if (line.trim().length > 0) rows.push({ kind: "note", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", newNo, text: line.slice(1) });
      newNo += 1;
      newLeft -= 1;
      added += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo, text: line.slice(1) });
      oldNo += 1;
      oldLeft -= 1;
      removed += 1;
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "note", text: line });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", oldNo, newNo, text: line.slice(1) });
      oldNo += 1;
      newNo += 1;
      oldLeft -= 1;
      newLeft -= 1;
    } else if (line === "") {
      // a blank context line whose leading space was trimmed
      rows.push({ kind: "ctx", oldNo, newNo, text: "" });
      oldNo += 1;
      newNo += 1;
      oldLeft -= 1;
      newLeft -= 1;
    } else {
      // text after the diff (omission markers, notes)
      inHunk = false;
      if (line.trim().length > 0) rows.push({ kind: "note", text: line });
    }
    // The hunk header says how many lines it holds; once they are all seen, a "--- x" line is a
    // new file header, not a deleted line.
    if (inHunk && oldLeft <= 0 && newLeft <= 0) inHunk = false;
  }
  return { rows, added, removed, files };
}

export function renderDiffView(diff: string, options: DiffViewOptions): DiffView {
  const { style, width, maxRows } = options;
  const parsed = parseUnifiedDiff(diff);
  const numbers = parsed.rows.flatMap((r) => [r.newNo, r.oldNo]).filter((n): n is number => n !== undefined);
  const gutter = Math.max(3, String(Math.max(0, ...numbers)).length);
  const textWidth = Math.max(10, width - gutter - 3);
  // Pad changed lines to a full-width bar only where a background shade will actually show.
  const shade = style.depth >= 8;
  const out: string[] = [];

  for (const row of parsed.rows) {
    if (row.kind === "file") {
      if (parsed.files > 1 || options.showFileNames) out.push(style.bold(row.text));
      continue;
    }
    if (row.kind === "sep") {
      out.push(style.dim(`${" ".repeat(gutter - 1)}${style.glyphs.ellipsis}`));
      continue;
    }
    if (row.kind === "note") {
      out.push(style.dim(truncate(row.text, width)));
      continue;
    }
    const no = String((row.kind === "del" ? row.oldNo : row.newNo) ?? "").padStart(gutter);
    const body = truncate(row.text, textWidth);
    if (row.kind === "add") {
      const line = `${style.dim(no)} + ${body}`;
      out.push(style.onBg("add", style.paint("diffAdd", shade ? padEnd(line, Math.min(width, gutter + 3 + textWidth)) : line)));
    } else if (row.kind === "del") {
      const line = `${style.dim(no)} - ${body}`;
      out.push(style.onBg("del", style.paint("diffDel", shade ? padEnd(line, Math.min(width, gutter + 3 + textWidth)) : line)));
    } else {
      out.push(style.dim(`${no}   ${body}`));
    }
  }

  let hidden = 0;
  let rows = out;
  if (out.length > maxRows) {
    hidden = out.length - (maxRows - 1);
    rows = [...out.slice(0, maxRows - 1), style.dim(`${" ".repeat(gutter - 1)}${style.glyphs.ellipsis} +${hidden} more lines`)];
  }
  // Guard: no row may exceed the width.
  rows = rows.map((row) => (visibleWidth(row) > width ? truncate(row, width) : row));
  return { rows, added: parsed.added, removed: parsed.removed, hidden };
}
