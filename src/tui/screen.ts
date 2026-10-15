/**
 * The live region.
 *
 * Interactive output is a normal scrolling terminal with a small block pinned at the bottom
 * (activity line, prompt box, status line). Text is *committed* above the block with
 * `print()` and becomes ordinary scrollback — selectable, searchable, copyable — while
 * `draw()` repaints only the block.
 *
 * Every update is one atomic write wrapped in synchronized-output markers, built from
 * relative cursor moves only: go up to the block's first row, rewrite each row (clearing the
 * old content first), clear whatever is left below, and park the cursor in the prompt.
 * Frame rows are always narrower than the terminal so an unexpected glyph width can never
 * wrap a row and desynchronize the row count.
 */

import { clip, visibleWidth } from "./width.js";

export interface ScreenOut {
  write(data: string): unknown;
  readonly columns: number;
  readonly rows: number;
}

export interface Frame {
  lines: string[];
  /** Where to park the cursor (row within `lines`, 0-based; col in cells). Hidden when absent. */
  cursor?: { row: number; col: number };
}

const ESC = "\u001b";
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const CLEAR_ROW = `${ESC}[2K`;
const CLEAR_BELOW = `${ESC}[J`;

interface Drawn {
  widths: number[];
  /** Row (within the block) the terminal cursor is on. */
  cursorRow: number;
  cursorCol: number;
}

export class LiveScreen {
  private drawn: Drawn | undefined;
  private lastFrame: Frame | undefined;

  constructor(
    private readonly out: ScreenOut,
    private readonly options: { sync?: boolean } = {},
  ) {}

  get columns(): number {
    return Math.max(20, this.out.columns || 80);
  }

  get rows(): number {
    return Math.max(5, this.out.rows || 24);
  }

  get mounted(): boolean {
    return this.drawn !== undefined;
  }

  /**
   * Commit rows above the live block (they become scrollback). `text` is the rows joined with
   * newlines — "" is one blank row, "a\n" is a row and a blank one. Pass the current `frame` so
   * the block is repainted with fresh state in the same write; otherwise the last one is reused.
   */
  print(text: string, frame?: Frame): void {
    const lines = normalize(text);
    if (!this.drawn) {
      this.out.write(`${lines.join("\r\n")}\r\n`);
      return;
    }
    this.paint(lines, frame ?? (this.lastFrame as Frame));
  }

  /** Replace the live block. */
  draw(frame: Frame): void {
    this.paint([], frame);
  }

  /** Erase the live block, leaving the cursor at its first row (for exit, suspend, child TTYs). */
  release(): void {
    if (!this.drawn) return;
    let buf = "";
    if (this.drawn.cursorRow > 0) buf += `${ESC}[${this.drawn.cursorRow}A`;
    buf += `\r${CLEAR_BELOW}${SHOW}`;
    this.out.write(buf);
    this.drawn = undefined;
    this.lastFrame = undefined;
  }

  /**
   * The terminal changed size. Terminals re-wrap the old block's rows, so work out how many
   * rows it occupies now, erase it, and forget it; the caller then draws a fresh frame.
   */
  beginResize(): void {
    if (!this.drawn) return;
    const cols = Math.max(1, this.out.columns || 80);
    const { widths, cursorRow } = this.drawn;
    let up = 0;
    for (let i = 0; i < cursorRow; i += 1) up += Math.max(1, Math.ceil(widths[i] / cols));
    let buf = "";
    if (up > 0) buf += `${ESC}[${up}A`;
    buf += `\r${CLEAR_BELOW}`;
    this.out.write(buf);
    this.drawn = undefined;
  }

  private paint(printed: string[], frame: Frame): void {
    const safe = Math.max(1, this.columns - 1);
    const maxRows = Math.max(1, this.rows - 1);
    let lines = frame.lines;
    let cursor = frame.cursor;
    if (lines.length > maxRows) {
      const dropped = lines.length - maxRows;
      lines = lines.slice(dropped);
      cursor = cursor ? { row: Math.max(0, cursor.row - dropped), col: cursor.col } : undefined;
    }
    lines = lines.map((line) => clip(line, safe));

    let buf = this.options.sync === false ? "" : SYNC_ON;
    buf += HIDE;
    if (this.drawn && this.drawn.cursorRow > 0) buf += `${ESC}[${this.drawn.cursorRow}A`;
    buf += "\r";
    for (const line of printed) buf += `${CLEAR_ROW}${line}\r\n`;
    lines.forEach((line, index) => {
      buf += `${CLEAR_ROW}${line}`;
      if (index < lines.length - 1) buf += "\r\n";
    });
    buf += CLEAR_BELOW;

    let cursorRow = Math.max(0, lines.length - 1);
    let cursorCol = lines.length > 0 ? visibleWidth(lines[lines.length - 1]) : 0;
    if (cursor && lines.length > 0) {
      const row = Math.max(0, Math.min(lines.length - 1, cursor.row));
      const up = lines.length - 1 - row;
      if (up > 0) buf += `${ESC}[${up}A`;
      cursorCol = Math.max(0, Math.min(safe - 1, cursor.col));
      buf += `${ESC}[${cursorCol + 1}G${SHOW}`;
      cursorRow = row;
    }
    if (this.options.sync !== false) buf += SYNC_OFF;

    this.out.write(buf);
    this.drawn = { widths: lines.map((line) => visibleWidth(line)), cursorRow, cursorCol };
    this.lastFrame = { lines, cursor };
  }
}

/** Split text into rows for a raw-mode terminal: LF/CRLF/CR all break rows; every element is one row. */
function normalize(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}
