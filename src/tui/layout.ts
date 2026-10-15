/**
 * Soft-wrap layout for the multi-line input: maps text indices to (row, column) cells
 * and back, so the editor can move the cursor vertically and the screen can draw it.
 */

import { graphemes, graphemeWidth } from "./width.js";

export interface Row {
  /** Index of the first character in the row. */
  start: number;
  /** Index one past the last character (excludes the newline that ended the logical line). */
  end: number;
  /** True when this row continues a logical line that was soft-wrapped. */
  continuation: boolean;
}

/** Break `text` into display rows of at most `width` cells, preferring to wrap after spaces. */
export function layoutRows(text: string, width: number): Row[] {
  const rows: Row[] = [];
  const avail = Math.max(1, width);
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    const parts = measure(line, offset);
    if (parts.length === 0) {
      rows.push({ start: offset, end: offset, continuation: false });
      offset = lineEnd + 1;
      continue;
    }
    let first = 0;
    let continuation = false;
    while (first < parts.length) {
      let used = 0;
      let fit = first;
      while (fit < parts.length && used + parts[fit].width <= avail) {
        used += parts[fit].width;
        fit += 1;
      }
      if (fit >= parts.length) {
        rows.push({ start: parts[first].start, end: lineEnd, continuation });
        break;
      }
      if (fit === first) fit += 1; // a single glyph wider than the row: still make progress
      let brk = fit;
      for (let k = fit; k > first; k -= 1) {
        if (parts[k - 1].text === " ") {
          brk = k;
          break;
        }
      }
      rows.push({ start: parts[first].start, end: brk >= parts.length ? lineEnd : parts[brk].start, continuation });
      first = brk;
      continuation = true;
    }
    offset = lineEnd + 1;
  }
  return rows;
}

interface Unit {
  text: string;
  start: number;
  width: number;
}

function measure(line: string, offset: number): Unit[] {
  const out: Unit[] = [];
  let index = offset;
  for (const g of graphemes(line)) {
    out.push({ text: g, start: index, width: graphemeWidth(g) });
    index += g.length;
  }
  return out;
}

export interface CursorCell {
  row: number;
  col: number;
}

/** Which row/column a text index falls on. */
export function locate(rows: Row[], text: string, cursor: number): CursorCell {
  let rowIndex = rows.length - 1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (cursor < row.end) {
      rowIndex = i;
      break;
    }
    if (cursor === row.end) {
      const next = rows[i + 1];
      // At a soft-wrap boundary the cursor belongs to the start of the next row.
      rowIndex = next && next.start === row.end && next.continuation ? i + 1 : i;
      break;
    }
  }
  const row = rows[rowIndex];
  return { row: rowIndex, col: cellsBetween(text, row.start, Math.min(cursor, row.end)) };
}

export function cellsBetween(text: string, from: number, to: number): number {
  let width = 0;
  for (const g of graphemes(text.slice(from, to))) width += graphemeWidth(g);
  return width;
}

/** Text index in `row` closest to column `col` (never past the end of the row). */
export function indexAtColumn(rows: Row[], text: string, rowIndex: number, col: number): number {
  const row = rows[rowIndex];
  let width = 0;
  let index = row.start;
  for (const g of graphemes(text.slice(row.start, row.end))) {
    const w = graphemeWidth(g);
    if (width + w > col) break;
    width += w;
    index += g.length;
  }
  // Do not land after the trailing space of a soft-wrapped row: that is the next row's start.
  const next = rows[rowIndex + 1];
  if (next && next.continuation && index >= row.end && row.end > row.start && text[row.end - 1] === " ") {
    return row.end - 1;
  }
  return index;
}
