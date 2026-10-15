/**
 * Markdown → terminal rows.
 *
 * Block structure (headings, lists, quotes, fenced code with highlighting, tables, rules) is
 * handled line by line so the same code serves one-shot rendering and token streaming:
 * `MarkdownStream.push` returns the rows that are final plus the still-growing tail. Long
 * paragraphs stream row by row instead of appearing all at once, and tables are buffered
 * until they end so their columns can be sized.
 */

import { createHighlighter, type Highlighter } from "./highlight.js";
import type { Style } from "./style.js";
import { padEnd, padStart, truncate, visibleWidth, wrapAnsi } from "./width.js";

export interface MdOptions {
  style: Style;
  /** Content width in cells (the caller indents the rows itself). */
  width: number;
}

/** How many wrapped rows of the line being written stay in the live tail before committing. */
const TAIL_ROWS = 4;

// --- inline -------------------------------------------------------------------------------

const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>";

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function findClosingRun(text: string, from: number, marker: string): number {
  let at = from;
  for (;;) {
    const idx = text.indexOf(marker, at);
    if (idx === -1) return -1;
    if (text[idx - 1] === "\\") {
      at = idx + 1;
      continue;
    }
    if (marker.length === 1 && (text[idx + 1] === marker || text[idx - 1] === marker)) {
      at = idx + 1;
      continue;
    }
    return idx;
  }
}

function parseLink(text: string, at: number): { label: string; url: string; end: number } | undefined {
  // text[at] === "["
  let depth = 0;
  let close = -1;
  for (let i = at; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || text[close + 1] !== "(") return undefined;
  let parens = 0;
  let end = -1;
  for (let i = close + 1; i < text.length; i += 1) {
    if (text[i] === "(") parens += 1;
    else if (text[i] === ")") {
      parens -= 1;
      if (parens === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return undefined;
  let url = text.slice(close + 2, end).trim();
  const title = /\s+["'][^"']*["']$/.exec(url);
  if (title) url = url.slice(0, title.index);
  url = url.replace(/^<|>$/g, "");
  return { label: text.slice(at + 1, close), url, end: end + 1 };
}

function renderLink(label: string, url: string, style: Style): string {
  const shown = label.trim().length > 0 ? renderInline(label, style, false) : url;
  const styled = style.underline(style.paint("link", shown));
  if (style.hyperlinks) return style.link(url, styled);
  if (label.trim() === url || label.trim().length === 0) return styled;
  return `${styled} ${style.dim(`(${url})`)}`;
}

/** Inline spans: `code`, **bold**, *italic*, ~~strike~~, [links](url), images, autolinks, escapes. */
export function renderInline(text: string, style: Style, autolink = true): string {
  if (!/[`*_~[\]<\\h!]/.test(text)) return text;
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];

    if (c === "\\" && i + 1 < n && ESCAPABLE.includes(text[i + 1])) {
      out += text[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      let run = 1;
      while (text[i + run] === "`") run += 1;
      let search = i + run;
      let close = -1;
      while (search < n) {
        const idx = text.indexOf("`", search);
        if (idx === -1) break;
        let len = 1;
        while (text[idx + len] === "`") len += 1;
        if (len === run) {
          close = idx;
          break;
        }
        search = idx + len;
      }
      if (close !== -1) {
        let code = text.slice(i + run, close);
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        out += style.paint("code", code);
        i = close + run;
        continue;
      }
      out += "`".repeat(run);
      i += run;
      continue;
    }

    if (c === "!" && text[i + 1] === "[") {
      const link = parseLink(text, i + 1);
      if (link) {
        out += style.dim(`[image: ${link.label || link.url}]`);
        i = link.end;
        continue;
      }
    }

    if (c === "[") {
      const link = parseLink(text, i);
      if (link) {
        out += renderLink(link.label, link.url, style);
        i = link.end;
        continue;
      }
    }

    if (c === "<") {
      const auto = /^<(https?:\/\/[^>\s]+)>/.exec(text.slice(i));
      if (auto) {
        out += renderLink(auto[1], auto[1], style);
        i += auto[0].length;
        continue;
      }
    }

    if ((c === "*" || c === "_") && text[i + 1] === c) {
      const marker = c + c;
      const end = findClosingRun(text, i + 2, marker);
      const inner = end === -1 ? "" : text.slice(i + 2, end);
      if (end !== -1 && inner.length > 0 && !/^\s/.test(inner) && !/\s$/.test(inner) && !(c === "_" && (isWordChar(text[i - 1]) || isWordChar(text[end + 2])))) {
        out += style.bold(renderInline(inner, style, autolink));
        i = end + 2;
        continue;
      }
    }

    if (c === "~" && text[i + 1] === "~") {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 2) {
        out += style.strike(renderInline(text.slice(i + 2, end), style, autolink));
        i = end + 2;
        continue;
      }
    }

    if (c === "*" || c === "_") {
      const blocked = c === "_" && isWordChar(text[i - 1]);
      if (!blocked && text[i + 1] !== undefined && !/\s/.test(text[i + 1])) {
        const end = findClosingRun(text, i + 1, c);
        if (end > i + 1 && !/\s/.test(text[end - 1]) && !(c === "_" && isWordChar(text[end + 1]))) {
          out += style.italic(renderInline(text.slice(i + 1, end), style, autolink));
          i = end + 1;
          continue;
        }
      }
    }

    if (autolink && c === "h" && !isWordChar(text[i - 1]) && /^https?:\/\//.test(text.slice(i, i + 8))) {
      const match = /^https?:\/\/[^\s<>]+/.exec(text.slice(i));
      if (match) {
        let url = match[0];
        // Trailing punctuation and unbalanced closers belong to the sentence, not the URL.
        for (;;) {
          const last = url.at(-1) as string;
          if (/[.,;:!?'"]/.test(last) || (last === ")" && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length)) url = url.slice(0, -1);
          else break;
        }
        out += renderLink(url, url, style);
        i += url.length;
        continue;
      }
    }

    out += c;
    i += 1;
  }
  return out;
}

// --- tables ---------------------------------------------------------------------------------

type Align = "left" | "center" | "right";

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (text[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += text[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

const SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function isSeparator(line: string): boolean {
  return line.includes("-") && line.includes("|") && SEPARATOR.test(line);
}

function looksLikeTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes("|") && (t.startsWith("|") || (t.match(/\|/g) ?? []).length >= 2);
}

function parseAligns(separator: string): Align[] {
  return splitRow(separator).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
}

function renderTable(header: string[], aligns: Align[], body: string[][], options: MdOptions): string[] {
  const { style, width } = options;
  const cols = header.length;
  const rows = [header, ...body.map((row) => Array.from({ length: cols }, (_, i) => row[i] ?? ""))];
  const cells = rows.map((row, r) => row.map((cell) => (r === 0 ? style.bold(renderInline(cell, style)) : renderInline(cell, style))));
  const natural = Array.from({ length: cols }, (_, c) => Math.max(...cells.map((row) => visibleWidth(row[c]))));
  const longestWord = Array.from({ length: cols }, (_, c) =>
    Math.max(...cells.map((row) => Math.max(0, ...row[c].split(/\s+/).map((w) => visibleWidth(w))))),
  );
  const overhead = cols * 3 + 1;
  const minWidth = longestWord.map((w, c) => Math.min(natural[c], Math.max(6, Math.min(w, 24))));
  const available = width - overhead;

  const box = style.glyphs.box;
  const paintBorder = (text: string): string => style.dim(text);

  if (available < minWidth.reduce((a, b) => a + b, 0)) {
    // Too narrow for a grid: stack each row as "header: value" lines.
    const out: string[] = [];
    body.forEach((row, index) => {
      if (index > 0) out.push("");
      header.forEach((name, c) => {
        const value = renderInline(row[c] ?? "", style);
        const label = style.bold(`${renderInline(name, style)}:`);
        out.push(...wrapAnsi(`${label} ${value}`, width, { indent: "  " }));
      });
    });
    return out;
  }

  const widths = [...natural];
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > available) {
    let widest = -1;
    for (let c = 0; c < cols; c += 1) {
      if (widths[c] > minWidth[c] && (widest === -1 || widths[c] > widths[widest])) widest = c;
    }
    if (widest === -1) break;
    widths[widest] -= 1;
    total -= 1;
  }

  const border = (left: string, mid: string, right: string): string =>
    paintBorder(left + widths.map((w) => box.h.repeat(w + 2)).join(mid) + right);
  const align = (text: string, c: number): string => {
    const w = widths[c];
    if (aligns[c] === "right") return padStart(text, w);
    if (aligns[c] === "center") {
      const gap = Math.max(0, w - visibleWidth(text));
      const left = Math.floor(gap / 2);
      return `${" ".repeat(left)}${text}${" ".repeat(gap - left)}`;
    }
    return padEnd(text, w);
  };

  const out: string[] = [border(box.tl, box.top, box.tr)];
  cells.forEach((row, r) => {
    const wrapped = row.map((cell, c) => wrapAnsi(cell, Math.max(1, widths[c])).map((line) => (visibleWidth(line) > widths[c] ? truncate(line, widths[c]) : line)));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    for (let line = 0; line < height; line += 1) {
      const parts = wrapped.map((lines, c) => ` ${align(lines[line] ?? "", c)} `);
      out.push(`${paintBorder(box.v)}${parts.join(paintBorder(box.v))}${paintBorder(box.v)}`);
    }
    if (r === 0) out.push(border(box.left, box.cross, box.right));
  });
  out.push(border(box.bl, box.bottom, box.br));
  return out;
}

// --- streaming block renderer ----------------------------------------------------------------

interface Fence {
  char: string;
  length: number;
}

export class MarkdownStream {
  private buffer = "";
  /** Rows of the current partial line already returned as final. */
  private committed = 0;
  private fence: Fence | undefined;
  private highlighter: Highlighter | undefined;
  private pendingHeader: string | undefined;
  private table: { header: string[]; aligns: Align[]; rows: string[][] } | undefined;
  private lastBlank = true;
  private started = false;

  constructor(private options: MdOptions) {}

  setWidth(width: number): void {
    this.options = { ...this.options, width };
  }

  get style(): Style {
    return this.options.style;
  }

  /** Feed a chunk. `lines` are final rows to print; `tail` is the unfinished line, shown live. */
  push(chunk: string): { lines: string[]; tail: string } {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const lines: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const rows = this.completeLine(line).slice(this.committed);
      lines.push(...rows);
      this.track(rows);
      this.committed = 0;
      newline = this.buffer.indexOf("\n");
    }
    const partial = this.partial();
    lines.push(...partial.commit);
    this.track(partial.commit);
    return { lines, tail: partial.tail };
  }

  /** End of input: emit everything still buffered. */
  flush(): string[] {
    const lines: string[] = [];
    const emit = (rows: string[]): void => {
      lines.push(...rows);
      this.track(rows);
    };
    if (this.buffer.length > 0) {
      const text = this.buffer;
      const skip = this.committed;
      this.buffer = "";
      this.committed = 0;
      emit(this.completeLine(text).slice(skip));
    }
    if (this.pendingHeader !== undefined) {
      const header = this.pendingHeader;
      this.pendingHeader = undefined;
      emit(this.paragraph(header));
    }
    if (this.table) emit(this.flushTable());
    if (this.fence) {
      this.fence = undefined;
      this.highlighter = undefined;
      emit([this.codeBottom()]);
    }
    return lines;
  }

  private track(rows: string[]): void {
    if (rows.length > 0) {
      this.started = true;
      this.lastBlank = rows[rows.length - 1] === "";
    }
  }

  // --- line handling ---

  private completeLine(line: string): string[] {
    if (this.fence) {
      const closing = new RegExp(`^\\s{0,3}${this.fence.char === "`" ? "`" : "~"}{${this.fence.length},}\\s*$`);
      if (closing.test(line)) {
        this.fence = undefined;
        this.highlighter = undefined;
        return [this.codeBottom()];
      }
      return this.codeRows(line);
    }

    if (this.table) {
      if (looksLikeTableRow(line) && line.trim().length > 0) {
        this.table.rows.push(splitRow(line));
        return [];
      }
      const rendered = this.flushTable();
      this.lastBlank = true; // a blank row follows the table; do not add another
      return [...rendered, "", ...this.completeLine(line)];
    }

    if (this.pendingHeader !== undefined) {
      const header = this.pendingHeader;
      this.pendingHeader = undefined;
      if (isSeparator(line)) {
        const headerCells = splitRow(header);
        const aligns = parseAligns(line);
        if (aligns.length === headerCells.length) {
          this.table = { header: headerCells, aligns, rows: [] };
          return [];
        }
      }
      return [...this.paragraph(header), ...this.completeLine(line)];
    }

    const open = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (open) {
      this.fence = { char: open[2][0], length: open[2].length };
      const lang = open[3] || undefined;
      this.highlighter = createHighlighter(lang, this.options.style);
      return [...this.spaceBefore(), this.codeTop(lang)];
    }

    if (looksLikeTableRow(line) && !/^\s*[-*+]\s/.test(line)) {
      this.pendingHeader = line;
      return [];
    }

    return this.block(line);
  }

  private spaceBefore(): string[] {
    return this.lastBlank || !this.started ? [] : [""];
  }

  private flushTable(): string[] {
    const table = this.table;
    this.table = undefined;
    if (!table) return [];
    return [...this.spaceBefore(), ...renderTable(table.header, table.aligns, table.rows, this.options)];
  }

  /** Rows for one non-code, non-table line. */
  private block(line: string): string[] {
    const { style, width } = this.options;
    if (line.trim().length === 0) return this.lastBlank ? [] : [""];

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = renderInline(heading[2], style);
      const styled = level === 1 ? style.bold(style.underline(style.paint("heading", text))) : level === 2 ? style.bold(style.paint("heading", text)) : style.bold(text);
      return [...this.spaceBefore(), ...wrapAnsi(styled, width)];
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      return [...this.spaceBefore(), style.dim(style.glyphs.rule.repeat(Math.min(width, 60)))];
    }

    const quote = /^((?:\s*>)+)\s?(.*)$/.exec(line);
    if (quote) {
      const depth = (quote[1].match(/>/g) ?? []).length;
      const bar = style.dim(`${style.glyphs.quote} `.repeat(depth));
      const inner = wrapAnsi(renderInline(quote[2], style), Math.max(10, width - depth * 2));
      return inner.map((row) => `${bar}${row}`);
    }

    const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (item) {
      const lead = item[1].replace(/\t/g, "  ").length;
      const depth = Math.min(Math.floor(lead / 2), 4);
      let marker: string;
      if (/^\d/.test(item[2])) marker = style.paint("accent", item[2]);
      else marker = style.paint("accent", style.glyphs.bulletLevels[depth % style.glyphs.bulletLevels.length]);
      let body = item[3];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
      if (task) {
        marker = task[1] === " " ? style.dim(style.glyphs.checkbox.off) : style.paint("ok", style.glyphs.checkbox.on);
        body = task[2];
      }
      const prefix = `${" ".repeat(lead)}${marker} `;
      const prefixWidth = visibleWidth(prefix);
      const hanging = " ".repeat(prefixWidth);
      const rows = wrapAnsi(renderInline(body, style), Math.max(10, width - prefixWidth));
      return rows.map((row, index) => `${index === 0 ? prefix : hanging}${row}`);
    }

    return this.paragraph(line);
  }

  private paragraph(line: string): string[] {
    const { style, width } = this.options;
    const lead = /^\s*/.exec(line)?.[0].replace(/\t/g, "  ").length ?? 0;
    const indent = " ".repeat(Math.min(lead, 8));
    return wrapAnsi(renderInline(line.trim(), style), Math.max(10, width - indent.length)).map((row) => `${indent}${row}`);
  }

  // --- code ---

  private codeTop(lang: string | undefined): string {
    const { style, width } = this.options;
    const label = lang ? ` ${lang} ` : "";
    const rule = style.glyphs.rule;
    const total = Math.min(width, 60);
    return style.dim(`${style.glyphs.corner[0]}${rule}${label}${rule.repeat(Math.max(2, total - visibleWidth(label) - 2))}`);
  }

  private codeBottom(): string {
    const { style, width } = this.options;
    return style.dim(`${style.glyphs.corner[2]}${style.glyphs.rule.repeat(Math.max(2, Math.min(width, 60) - 1))}`);
  }

  private codeRows(line: string): string[] {
    const { style, width } = this.options;
    const text = line.replace(/\t/g, "  ");
    const body = this.highlighter ? this.highlighter.line(text) : text;
    const gutter = style.dim(`${style.glyphs.box.v} `);
    const rows = visibleWidth(body) <= width - 2 ? [body] : wrapAnsi(body, width - 2);
    return rows.map((row) => `${gutter}${row}`);
  }

  // --- partial (streaming) line ---

  private partial(): { commit: string[]; tail: string } {
    const { style, width } = this.options;
    const text = this.buffer;
    if (text.length === 0) return { commit: [], tail: "" };
    if (this.fence) {
      const row = this.codeRows(text).join("\n");
      return { commit: [], tail: row };
    }
    if (this.table || this.pendingHeader !== undefined || /^\s{0,3}(`{3,}|~{3,}|#)/.test(text) || looksLikeTableRow(text)) {
      return { commit: [], tail: style.dim(truncate(text, Math.max(10, width))) };
    }
    const rows = this.block(text);
    const finalRows = rows.length;
    const keep = TAIL_ROWS;
    let commit: string[] = [];
    if (finalRows > keep + this.committed) {
      const upTo = finalRows - keep;
      commit = rows.slice(this.committed, upTo);
      this.committed = upTo;
    }
    return { commit, tail: rows.slice(this.committed).join("\n") };
  }
}

/** One-shot: render a whole markdown string to rows. */
export function renderMarkdownRows(text: string, options: MdOptions): string[] {
  const stream = new MarkdownStream(options);
  const first = stream.push(text.endsWith("\n") ? text : `${text}\n`);
  return [...first.lines, ...stream.flush()];
}

export function renderMarkdown(text: string, options: MdOptions): string {
  return renderMarkdownRows(text, options).join("\n");
}
