/**
 * A tiny terminal emulator for tests: enough of VT100/xterm to replay what the TUI emits
 * (cursor movement, erase line/screen, autowrap with a deferred-wrap flag, scrolling into a
 * scrollback list) and read back what a user would actually see.
 */

import { graphemes, graphemeWidth } from "../tui/width.js";

export class MiniTerminal {
  rows: number;
  cols: number;
  private grid: string[][];
  readonly scrollback: string[] = [];
  x = 0;
  y = 0;
  cursorVisible = true;
  private wrapPending = false;
  /** Every distinct private mode that was last set (e.g. 2026, 2004). */
  readonly modes = new Map<number, boolean>();

  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => this.blankRow());
  }

  private blankRow(): string[] {
    return Array.from({ length: this.cols }, () => " ");
  }

  resize(cols: number, rows: number): void {
    const next = Array.from({ length: rows }, (_, r) => {
      const row = Array.from({ length: cols }, () => " ");
      const old = this.grid[r];
      if (old) for (let c = 0; c < Math.min(cols, old.length); c += 1) row[c] = old[c];
      return row;
    });
    this.grid = next;
    this.cols = cols;
    this.rows = rows;
    this.x = Math.min(this.x, cols - 1);
    this.y = Math.min(this.y, rows - 1);
    this.wrapPending = false;
  }

  /** Visible screen rows, right-trimmed. */
  lines(): string[] {
    return this.grid.map((row) => row.join("").replace(/\s+$/, ""));
  }

  /** Scrollback plus screen, as one transcript (blank trailing rows dropped). */
  transcript(): string[] {
    const all = [...this.scrollback, ...this.lines()];
    while (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all;
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\u001b") {
        i = this.escape(data, i);
        continue;
      }
      if (ch === "\r") {
        this.x = 0;
        this.wrapPending = false;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        this.lineFeed();
        this.wrapPending = false;
        i += 1;
        continue;
      }
      if (ch === "\t") {
        this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
        i += 1;
        continue;
      }
      if (ch === "\u0007" || ch.charCodeAt(0) < 0x20) {
        i += 1;
        continue;
      }
      // Printable run: grapheme by grapheme.
      let end = i;
      while (end < data.length && data[end] !== "\u001b" && data.charCodeAt(end) >= 0x20) end += 1;
      for (const g of graphemes(data.slice(i, end))) this.put(g);
      i = end;
    }
  }

  private put(g: string): void {
    const width = graphemeWidth(g);
    if (width === 0) return;
    if (this.wrapPending || this.x + width > this.cols) {
      this.x = 0;
      this.lineFeed();
      this.wrapPending = false;
    }
    this.grid[this.y][this.x] = g;
    if (width === 2 && this.x + 1 < this.cols) this.grid[this.y][this.x + 1] = "";
    this.x += width;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
      this.wrapPending = true;
    }
  }

  private lineFeed(): void {
    if (this.y === this.rows - 1) {
      this.scrollback.push(this.grid[0].join("").replace(/\s+$/, ""));
      this.grid.shift();
      this.grid.push(this.blankRow());
    } else {
      this.y += 1;
    }
  }

  private escape(data: string, start: number): number {
    const next = data[start + 1];
    if (next === "[") {
      let i = start + 2;
      while (i < data.length && !(data.charCodeAt(i) >= 0x40 && data.charCodeAt(i) <= 0x7e)) i += 1;
      if (i >= data.length) return data.length;
      this.csi(data.slice(start + 2, i), data[i]);
      return i + 1;
    }
    if (next === "]") {
      const bel = data.indexOf("\u0007", start);
      const st = data.indexOf("\u001b\\", start);
      const ends = [bel === -1 ? Infinity : bel + 1, st === -1 ? Infinity : st + 2];
      const end = Math.min(...ends);
      return end === Infinity ? data.length : end;
    }
    return start + 2;
  }

  private csi(params: string, final: string): void {
    const privateMode = params.startsWith("?");
    const clean = params.replace(/^[?<>=]/, "");
    const nums = clean.split(";").map((p) => (p === "" ? undefined : Number.parseInt(p, 10)));
    const n = (index: number, fallback: number): number => nums[index] ?? fallback;

    if (privateMode && (final === "h" || final === "l")) {
      for (const mode of nums) {
        if (mode === undefined) continue;
        this.modes.set(mode, final === "h");
        if (mode === 25) this.cursorVisible = final === "h";
      }
      return;
    }
    if (params.startsWith(">") || params.startsWith("<") || params.startsWith("=")) return;

    switch (final) {
      case "A":
        this.y = Math.max(0, this.y - Math.max(1, n(0, 1)));
        this.wrapPending = false;
        break;
      case "B":
        this.y = Math.min(this.rows - 1, this.y + Math.max(1, n(0, 1)));
        this.wrapPending = false;
        break;
      case "C":
        this.x = Math.min(this.cols - 1, this.x + Math.max(1, n(0, 1)));
        this.wrapPending = false;
        break;
      case "D":
        this.x = Math.max(0, this.x - Math.max(1, n(0, 1)));
        this.wrapPending = false;
        break;
      case "G":
        this.x = Math.max(0, Math.min(this.cols - 1, n(0, 1) - 1));
        this.wrapPending = false;
        break;
      case "H":
      case "f":
        this.y = Math.max(0, Math.min(this.rows - 1, n(0, 1) - 1));
        this.x = Math.max(0, Math.min(this.cols - 1, n(1, 1) - 1));
        this.wrapPending = false;
        break;
      case "K": {
        const mode = n(0, 0);
        const row = this.grid[this.y];
        const from = mode === 1 || mode === 2 ? 0 : this.x;
        const to = mode === 0 || mode === 2 ? this.cols - 1 : this.x;
        for (let c = from; c <= to; c += 1) row[c] = " ";
        break;
      }
      case "J": {
        const mode = n(0, 0);
        if (mode === 0) {
          for (let c = this.x; c < this.cols; c += 1) this.grid[this.y][c] = " ";
          for (let r = this.y + 1; r < this.rows; r += 1) this.grid[r] = this.blankRow();
        } else if (mode === 1) {
          for (let c = 0; c <= this.x; c += 1) this.grid[this.y][c] = " ";
          for (let r = 0; r < this.y; r += 1) this.grid[r] = this.blankRow();
        } else if (mode === 2) {
          for (let r = 0; r < this.rows; r += 1) this.grid[r] = this.blankRow();
        } else if (mode === 3) {
          this.scrollback.length = 0;
        }
        break;
      }
      default:
        break; // SGR and everything else do not change layout
    }
  }
}
