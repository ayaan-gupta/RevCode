/**
 * Terminal text measurement: display width (wide CJK/emoji, zero-width marks),
 * grapheme segmentation, and ANSI-aware truncation / word wrapping.
 *
 * Everything that positions a cursor or sizes a redrawable region depends on
 * these being right, so they are kept dependency-free and heavily tested.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const REGIONAL_INDICATOR_PAIR = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isWide(codePoint: number): boolean {
  if (codePoint < 0x1100) return false;
  let low = 0;
  let high = WIDE_RANGES.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = WIDE_RANGES[mid];
    if (codePoint < start) high = mid - 1;
    else if (codePoint > end) low = mid + 1;
    else return true;
  }
  return false;
}

/** Split into user-perceived characters (emoji sequences and combining marks stay together). */
export function graphemes(text: string): string[] {
  if (text.length === 0) return [];
  // Fast path: printable ASCII is one cell and one grapheme per char.
  if (/^[\x20-\x7e]*$/.test(text)) return Array.from(text);
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Cells one grapheme cluster occupies (0, 1 or 2). */
export function graphemeWidth(cluster: string): number {
  if (cluster.length === 0) return 0;
  const first = cluster.codePointAt(0) as number;
  if (first < 0x20 || (first >= 0x7f && first < 0xa0)) return 0;
  if (first < 0x300) return 1;
  if (ZERO_WIDTH.test(cluster)) return 0;
  if (REGIONAL_INDICATOR_PAIR.test(cluster)) return 2;
  if (cluster.includes("️") || cluster.includes("‍")) {
    // VS16 requests emoji presentation; a ZWJ sequence renders as one emoji glyph.
    return EMOJI_PRESENTATION.test(cluster) || cluster.includes("️") || cluster.includes("‍") ? 2 : 1;
  }
  if (isWide(first) || EMOJI_PRESENTATION.test(String.fromCodePoint(first))) return 2;
  return 1;
}

// CSI ... final byte, and OSC ... (BEL | ESC \)
const ANSI_PATTERN = /\u001b\[[0-9;:?<=>]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/y;

interface Token {
  /** Text of the token (an escape sequence or one grapheme). */
  text: string;
  width: number;
  escape: boolean;
}

function* tokenize(text: string): Generator<Token> {
  let index = 0;
  let plainStart = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) === 0x1b) {
      if (plainStart < index) {
        for (const g of graphemes(text.slice(plainStart, index))) {
          yield { text: g, width: graphemeWidth(g), escape: false };
        }
      }
      ANSI_PATTERN.lastIndex = index;
      const match = ANSI_PATTERN.exec(text);
      if (match) {
        yield { text: match[0], width: 0, escape: true };
        index += match[0].length;
      } else {
        // A bare ESC we cannot parse: drop it (zero width) so it cannot corrupt layout.
        yield { text: "\u001b", width: 0, escape: true };
        index += 1;
      }
      plainStart = index;
      continue;
    }
    index += 1;
  }
  if (plainStart < text.length) {
    for (const g of graphemes(text.slice(plainStart))) {
      yield { text: g, width: graphemeWidth(g), escape: false };
    }
  }
}

/** Display width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  if (text.length === 0) return 0;
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let width = 0;
  for (const token of tokenize(text)) width += token.width;
  return width;
}

export function stripAnsi(text: string): string {
  let out = "";
  for (const token of tokenize(text)) {
    if (!token.escape) out += token.text;
  }
  return out;
}

const SGR_RESET = "\u001b[0m";

/**
 * Tracks which SGR attributes are active so a styled run can be closed at the end of a row
 * and re-opened on the next. Understands both "off" codes (22, 39, ...) and full resets.
 */
export class SgrState {
  private bold = false;
  private dim = false;
  private italic = false;
  private underline = false;
  private inverse = false;
  private strike = false;
  private fg: string | undefined;
  private bg: string | undefined;
  /** URL of the OSC 8 hyperlink currently open, if any. */
  private link: string | undefined;

  get isDefault(): boolean {
    return !(this.bold || this.dim || this.italic || this.underline || this.inverse || this.strike || this.fg || this.bg || this.link);
  }

  apply(sequence: string): void {
    if (sequence.startsWith("\u001b]8;")) {
      const url = sequence.slice(4).replace(/^[^;]*;/, "").replace(/(?:\u0007|\u001b\\)$/, "");
      this.link = url.length > 0 ? url : undefined;
      return;
    }
    const body = sequence.slice(2, -1);
    const params = body === "" ? [0] : body.split(/[;:]/).map((p) => (p === "" ? 0 : Number.parseInt(p, 10)));
    for (let i = 0; i < params.length; i += 1) {
      const n = params[i];
      if (n === 0) this.reset();
      else if (n === 1) this.bold = true;
      else if (n === 2) this.dim = true;
      else if (n === 3) this.italic = true;
      else if (n === 4) this.underline = true;
      else if (n === 7) this.inverse = true;
      else if (n === 9) this.strike = true;
      else if (n === 22) {
        this.bold = false;
        this.dim = false;
      } else if (n === 23) this.italic = false;
      else if (n === 24) this.underline = false;
      else if (n === 27) this.inverse = false;
      else if (n === 29) this.strike = false;
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) this.fg = String(n);
      else if (n === 39) this.fg = undefined;
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) this.bg = String(n);
      else if (n === 49) this.bg = undefined;
      else if (n === 38 || n === 48) {
        const mode = params[i + 1];
        const count = mode === 5 ? 2 : mode === 2 ? 4 : 0;
        const value = [n, ...params.slice(i + 1, i + 1 + count)].join(";");
        if (n === 38) this.fg = value;
        else this.bg = value;
        i += count;
      }
    }
  }

  reset(): void {
    this.bold = this.dim = this.italic = this.underline = this.inverse = this.strike = false;
    this.fg = this.bg = undefined;
  }

  /** Sequence that closes everything still open at the end of a row (styles and hyperlink). */
  closer(): string {
    const sgrOpen = this.bold || this.dim || this.italic || this.underline || this.inverse || this.strike || this.fg || this.bg;
    return `${sgrOpen ? SGR_RESET : ""}${this.link ? "\u001b]8;;\u001b\\" : ""}`;
  }

  /** One escape sequence that recreates this state from a reset terminal ("" when default). */
  toSequence(): string {
    const parts: string[] = [];
    if (this.bold) parts.push("1");
    if (this.dim) parts.push("2");
    if (this.italic) parts.push("3");
    if (this.underline) parts.push("4");
    if (this.inverse) parts.push("7");
    if (this.strike) parts.push("9");
    if (this.fg) parts.push(this.fg);
    if (this.bg) parts.push(this.bg);
    const sgr = parts.length === 0 ? "" : `\u001b[${parts.join(";")}m`;
    return this.link ? `${sgr}\u001b]8;;${this.link}\u001b\\` : sgr;
  }
}


function isStyleSequence(sequence: string): boolean {
  return /^\u001b\[[0-9;:]*m$/.test(sequence) || sequence.startsWith("\u001b]8;");
}

function cutWithin(text: string, budget: number): { out: string; used: number; cut: boolean; open: boolean; closer: string } {
  let out = "";
  let used = 0;
  let cut = false;
  const state = new SgrState();
  for (const token of tokenize(text)) {
    if (token.escape) {
      out += token.text;
      if (isStyleSequence(token.text)) state.apply(token.text);
      continue;
    }
    if (used + token.width > budget) {
      cut = true;
      break;
    }
    out += token.text;
    used += token.width;
  }
  return { out, used, cut, open: !state.isDefault, closer: state.closer() };
}

/** Truncate to `max` cells, keeping styles balanced and appending `ellipsis` when cut. */
export function truncate(text: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  const { out, open, closer } = cutWithin(text, Math.max(0, max - visibleWidth(ellipsis)));
  return `${out}${open ? closer : ""}${ellipsis}`;
}

/** Hard-cut to `max` cells with no ellipsis (used for frame lines that must never wrap). */
export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  const { out, open, closer } = cutWithin(text, max);
  return open ? `${out}${closer}` : out;
}

export function padEnd(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text;
}

export function padStart(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? `${" ".repeat(gap)}${text}` : text;
}

export interface WrapOptions {
  /** Prefix for continuation rows (hanging indent). */
  indent?: string;
  /** Break words longer than the row (default true). */
  breakLongWords?: boolean;
}

/**
 * Word-wrap text that may contain ANSI styling into rows of at most `width` cells.
 * Active SGR styles are closed at the end of a row and re-opened at the start of the
 * next, so every row is independently safe to print. Existing newlines are kept.
 */
export function wrapAnsi(text: string, width: number, options: WrapOptions = {}): string[] {
  const rows: string[] = [];
  for (const paragraph of text.split("\n")) {
    rows.push(...wrapParagraph(paragraph, width, options));
  }
  return rows;
}

function wrapParagraph(text: string, width: number, options: WrapOptions): string[] {
  const indent = options.indent ?? "";
  const indentWidth = visibleWidth(indent);
  const breakLong = options.breakLongWords ?? true;
  if (width < 2 || visibleWidth(text) <= width) return [text];

  // Break into words and runs of spaces. Escape sequences attach to the word that follows
  // (or precedes) them, so a style change is never lost when whitespace is dropped at a wrap.
  interface Piece {
    text: string;
    width: number;
    space: boolean;
  }
  const pieces: Piece[] = [];
  let current: Piece | undefined;
  for (const token of tokenize(text)) {
    if (token.escape) {
      if (!current || current.space) {
        current = { text: "", width: 0, space: false };
        pieces.push(current);
      }
      current.text += token.text;
      continue;
    }
    const isSpace = token.text === " ";
    if (!current || current.space !== isSpace) {
      current = { text: "", width: 0, space: isSpace };
      pieces.push(current);
    }
    current.text += token.text;
    current.width += token.width;
  }

  const rows: string[] = [];
  const state = new SgrState(); // SGR attributes in effect at the current position
  let row = "";
  let rowWidth = 0;
  let hasWord = false;
  let pendingSpace = "";
  let pendingSpaceWidth = 0;

  const track = (chunk: string): void => {
    for (const match of chunk.matchAll(/\u001b\[[0-9;:]*m|\u001b\]8;[^;\u0007\u001b]*;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g)) state.apply(match[0]);
  };
  const closeRow = (): void => {
    rows.push(`${row}${state.closer()}`);
    row = `${indent}${state.toSequence()}`;
    rowWidth = indentWidth;
    hasWord = false;
    pendingSpace = "";
    pendingSpaceWidth = 0;
  };

  for (const piece of pieces) {
    if (piece.space) {
      pendingSpace += piece.text;
      pendingSpaceWidth += piece.width;
      continue;
    }
    if (rowWidth + pendingSpaceWidth + piece.width <= width) {
      row += pendingSpace + piece.text;
      rowWidth += pendingSpaceWidth + piece.width;
      hasWord = hasWord || piece.width > 0;
      pendingSpace = "";
      pendingSpaceWidth = 0;
      track(piece.text);
      continue;
    }
    if (hasWord) closeRow();
    else {
      // Leading whitespace on a row that cannot hold the word: keep it only if the word fits after it.
      if (rowWidth + pendingSpaceWidth + piece.width <= width) {
        row += pendingSpace;
        rowWidth += pendingSpaceWidth;
      }
      pendingSpace = "";
      pendingSpaceWidth = 0;
    }
    if (piece.width <= width - rowWidth || !breakLong) {
      row += piece.text;
      rowWidth += piece.width;
      hasWord = true;
      track(piece.text);
      continue;
    }
    for (const token of tokenize(piece.text)) {
      if (token.escape) {
        row += token.text;
        track(token.text);
        continue;
      }
      if (rowWidth + token.width > width && hasWord) closeRow();
      row += token.text;
      rowWidth += token.width;
      hasWord = true;
    }
  }
  rows.push(row);
  return rows;
}

/** Index in `text` (UTF-16) of the grapheme boundary at or before `target` cells from the start. */
export function indexAtWidth(text: string, target: number): number {
  let width = 0;
  let index = 0;
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (width + w > target) break;
    width += w;
    index += g.length;
  }
  return index;
}
