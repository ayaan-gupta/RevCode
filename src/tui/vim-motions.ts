/** Cursor motions for the prompt's Vim mode, over a list of grapheme cells. Pure and unit-tested. */

export interface Cell {
  text: string;
  start: number;
  end: number;
}

type Class = 0 | 1 | 2; // blank, word, punctuation

function classOf(cell: Cell | undefined, big: boolean): Class {
  if (!cell) return 0;
  if (/^\s/.test(cell.text)) return 0;
  if (big) return 1;
  return /^[\p{L}\p{N}_]/u.test(cell.text) ? 1 : 2;
}

function indexOfCell(cells: Cell[], at: number): number {
  const i = cells.findIndex((c) => c.end > at);
  return i === -1 ? cells.length : i;
}

/** `w` / `W`: start of the next word (a newline counts as a word of its own, as in Vim). */
export function wordForward(cells: Cell[], at: number, count: number, big = false): number {
  let i = indexOfCell(cells, at);
  for (let n = 0; n < count; n += 1) {
    if (i >= cells.length) break;
    const start = classOf(cells[i], big);
    if (start !== 0) while (i < cells.length && classOf(cells[i], big) === start) i += 1;
    while (i < cells.length && classOf(cells[i], big) === 0 && cells[i].text !== "\n") i += 1;
    if (i < cells.length && cells[i].text === "\n" && n < count - 1) i += 1;
  }
  return i >= cells.length ? (cells.at(-1)?.end ?? 0) : cells[i].start;
}

/** `b` / `B`: start of the previous word. */
export function wordBackward(cells: Cell[], at: number, count: number, big = false): number {
  let i = indexOfCell(cells, at) - 1;
  for (let n = 0; n < count; n += 1) {
    while (i > 0 && classOf(cells[i], big) === 0) i -= 1;
    const cls = classOf(cells[i], big);
    while (i > 0 && classOf(cells[i - 1], big) === cls) i -= 1;
    if (n < count - 1 && i > 0) i -= 1;
  }
  return cells[Math.max(0, i)]?.start ?? 0;
}

/** `e` / `E`: last character of the current or next word. */
export function wordEnd(cells: Cell[], at: number, count: number, big = false): number {
  let i = indexOfCell(cells, at);
  for (let n = 0; n < count; n += 1) {
    i += 1;
    while (i < cells.length && classOf(cells[i], big) === 0) i += 1;
    const cls = classOf(cells[i], big);
    while (i + 1 < cells.length && classOf(cells[i + 1], big) === cls) i += 1;
  }
  const last = Math.min(i, cells.length - 1);
  return cells[Math.max(0, last)]?.start ?? 0;
}

export function lineStartOf(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

export function lineEndOf(text: string, at: number): number {
  const i = text.indexOf("\n", at);
  return i === -1 ? text.length : i;
}

export function firstNonBlank(text: string, at: number): number {
  const start = lineStartOf(text, at);
  const end = lineEndOf(text, at);
  let i = start;
  while (i < end && /[ \t]/.test(text[i])) i += 1;
  return i;
}

/** `f` `F` `t` `T`: find `char` on the current line; returns the target index (undefined if absent). */
export function findChar(text: string, at: number, char: string, kind: "f" | "F" | "t" | "T", count: number): number | undefined {
  const start = lineStartOf(text, at);
  const end = lineEndOf(text, at);
  let i = at;
  const forward = kind === "f" || kind === "t";
  for (let n = 0; n < count; n += 1) {
    i = forward ? text.indexOf(char, i + 1) : text.lastIndexOf(char, i - 1);
    if (i === -1 || i < start || i >= end) return undefined;
  }
  if (kind === "t") return i - 1;
  if (kind === "T") return i + 1;
  return i;
}
