/**
 * The prompt editor: a pure state machine (no I/O) that owns the text, cursor, history
 * navigation, undo, kill ring, collapsed pastes, reverse search, and the completion menu.
 *
 * The UI feeds it `KeyEvent`s and draws `view()`; anything the editor does not own (Ctrl+C,
 * Escape on an idle prompt, Shift+Tab, Ctrl+L, …) comes back as `unhandled` so the host can
 * decide. Keeping it free of terminal output makes every behavior unit-testable.
 */

import type { Completer, CompletionItem, CompletionResult } from "./completion.js";
import type { KeyEvent } from "./keys.js";
import { indexAtColumn, layoutRows, locate } from "./layout.js";
import { graphemes } from "./width.js";

export type EditorResult =
  | { type: "handled" }
  /** `text` has pasted placeholders expanded (send this); `display` is what was typed (show this). */
  | { type: "submit"; text: string; display: string }
  | { type: "unhandled" };

export interface EditorView {
  /** Visible rows of plain text (the host adds the prompt prefix and styling). */
  rows: string[];
  cursor: { row: number; col: number };
  hiddenAbove: number;
  hiddenBelow: number;
  search?: { query: string; failed: boolean };
}

export interface MenuView {
  items: CompletionItem[];
  /** Index into `items` of the highlighted entry. */
  selected: number;
  /** Window of items to draw (`items.slice(first, first + count)`). */
  first: number;
  count: number;
  total: number;
}

const PLACEHOLDER_GLOBAL = /\[Pasted text #(\d+)(?: \+\d+ lines| \d[\d,]* chars)?\]/g;
const PASTE_COLLAPSE_LINES = 5;
const PASTE_COLLAPSE_CHARS = 1000;
const MENU_ROWS = 8;
const MAX_UNDO = 200;

interface Unit {
  text: string;
  start: number;
  end: number;
  placeholder: boolean;
}

interface Snapshot {
  text: string;
  cursor: number;
}

export interface EditorOptions {
  history?: readonly string[];
  completer?: Completer;
  /** Rewrite a paste before it is inserted (e.g. a dropped file path → an @mention). */
  transformPaste?: (text: string) => string | undefined;
  /** Enter on an empty line submits "" instead of being ignored (optional prompts). */
  allowEmpty?: boolean;
}

export class LineEditor {
  private text = "";
  private cursor = 0;
  private goalColumn: number | undefined;
  private width = 80;
  private scrollTop = 0;

  private history: string[];
  private historyIndex = -1;
  private draft = "";

  private undoStack: Snapshot[] = [];
  private lastEdit = "";

  private killBuffer = "";
  private lastWasKill = false;

  private pastes = new Map<number, string>();
  private pasteCounter = 0;

  private search: { query: string; match: number; saved: Snapshot } | undefined;

  private completer: Completer | undefined;
  private transformPaste: ((text: string) => string | undefined) | undefined;
  private allowEmpty: boolean;
  private menu: { result: CompletionResult; selected: number; first: number } | undefined;
  private menuDismissedFor: string | undefined;
  private menuSuspended = false;

  private unitCache: { text: string; units: Unit[] } | undefined;

  constructor(options: EditorOptions = {}) {
    this.history = [...(options.history ?? [])];
    this.completer = options.completer;
    this.transformPaste = options.transformPaste;
    this.allowEmpty = options.allowEmpty ?? false;
  }

  // --- accessors ---------------------------------------------------------------------

  getText(): string {
    return this.text;
  }

  getCursor(): number {
    return this.cursor;
  }

  isEmpty(): boolean {
    return this.text.length === 0;
  }

  setCompleter(completer: Completer | undefined): void {
    this.completer = completer;
    this.refreshMenu();
  }

  setWidth(width: number): void {
    this.width = Math.max(4, width);
  }

  /** Replace the text (undoable); the cursor goes to the end. */
  setText(text: string, options: { undoable?: boolean; suspendMenu?: boolean } = {}): void {
    if (options.undoable !== false) this.recordUndo("set", true);
    this.text = text;
    this.cursor = text.length;
    this.goalColumn = undefined;
    this.lastWasKill = false;
    this.menuSuspended = options.suspendMenu ?? false;
    this.afterChange();
  }

  clear(): void {
    if (this.text.length === 0) return;
    this.recordUndo("clear", true);
    this.text = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.afterChange();
  }

  /** Insert text at the cursor as if typed (used by hosts for completions they drive). */
  insert(text: string): void {
    this.insertText(text);
  }

  /** Remember a submitted prompt for Up-arrow recall. */
  addHistory(entry: string): void {
    const trimmed = entry.replace(/\s+$/, "");
    if (trimmed.trim().length === 0 || this.history.at(-1) === trimmed) return;
    this.history.push(trimmed);
  }

  menuView(): MenuView | undefined {
    if (!this.menu) return undefined;
    const { items } = this.menu.result;
    const count = Math.min(MENU_ROWS, items.length);
    return { items, selected: this.menu.selected, first: this.menu.first, count, total: items.length };
  }

  searching(): boolean {
    return this.search !== undefined;
  }

  // --- view --------------------------------------------------------------------------

  view(width: number, maxRows: number): EditorView {
    this.setWidth(width);
    const rows = layoutRows(this.text, this.width);
    const cell = locate(rows, this.text, this.cursor);
    const window = Math.max(1, maxRows);
    if (rows.length <= window) {
      this.scrollTop = 0;
    } else {
      if (cell.row < this.scrollTop) this.scrollTop = cell.row;
      if (cell.row >= this.scrollTop + window) this.scrollTop = cell.row - window + 1;
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, rows.length - window));
    }
    const visible = rows.slice(this.scrollTop, this.scrollTop + window);
    return {
      rows: visible.map((row) => this.text.slice(row.start, row.end)),
      cursor: { row: cell.row - this.scrollTop, col: cell.col },
      hiddenAbove: this.scrollTop,
      hiddenBelow: Math.max(0, rows.length - this.scrollTop - visible.length),
      search: this.search ? { query: this.search.query, failed: this.search.match === -1 && this.search.query.length > 0 } : undefined,
    };
  }

  // --- key handling ------------------------------------------------------------------

  handle(ev: KeyEvent): EditorResult {
    if (this.search) return this.handleSearchKey(ev);

    if (ev.name === "paste") {
      this.insertPaste(ev.text ?? "");
      return { type: "handled" };
    }
    if (ev.name === "text") {
      this.typeText(ev.text ?? "");
      return { type: "handled" };
    }

    const plain = !ev.ctrl && !ev.alt && !ev.shift;

    if (this.menu) {
      const handled = this.handleMenuKey(ev);
      if (handled) return handled;
    }

    switch (ev.name) {
      case "return":
        if (ev.shift || ev.alt) {
          this.insertNewline();
          return { type: "handled" };
        }
        return this.submit();
      case "j":
        if (ev.ctrl) {
          this.insertNewline();
          return { type: "handled" };
        }
        break;
      case "backspace":
        if (ev.alt) this.killWordBack();
        else this.deleteBack();
        return { type: "handled" };
      case "delete":
        if (ev.ctrl || ev.alt) this.killWordForward();
        else this.deleteForward();
        return { type: "handled" };
      case "left":
        this.moveCursor(ev.ctrl || ev.alt ? this.wordLeft(this.cursor) : this.prev(this.cursor), "left");
        return { type: "handled" };
      case "right":
        this.moveCursor(ev.ctrl || ev.alt ? this.wordRight(this.cursor) : this.next(this.cursor), "right");
        return { type: "handled" };
      case "home":
        this.moveCursor(this.lineStart(this.cursor), "left");
        return { type: "handled" };
      case "end":
        this.moveCursor(this.lineEnd(this.cursor), "right");
        return { type: "handled" };
      case "up":
        if (plain) {
          this.up();
          return { type: "handled" };
        }
        break;
      case "down":
        if (plain) {
          this.down();
          return { type: "handled" };
        }
        break;
      case "escape":
        if (this.menu) {
          this.menuDismissedFor = this.text;
          this.menu = undefined;
          return { type: "handled" };
        }
        return { type: "unhandled" };
      default:
        break;
    }

    if (ev.ctrl && !ev.alt) {
      switch (ev.name) {
        case "a":
          this.moveCursor(this.lineStart(this.cursor), "left");
          return { type: "handled" };
        case "e":
          this.moveCursor(this.lineEnd(this.cursor), "right");
          return { type: "handled" };
        case "b":
          this.moveCursor(this.prev(this.cursor), "left");
          return { type: "handled" };
        case "f":
          this.moveCursor(this.next(this.cursor), "right");
          return { type: "handled" };
        case "h":
          this.deleteBack();
          return { type: "handled" };
        case "d":
          if (this.text.length === 0) return { type: "unhandled" };
          this.deleteForward();
          return { type: "handled" };
        case "k":
          this.killToLineEnd();
          return { type: "handled" };
        case "u":
          this.killToLineStart();
          return { type: "handled" };
        case "w":
          this.killWordBack(true);
          return { type: "handled" };
        case "y":
          this.yank();
          return { type: "handled" };
        case "t":
          this.transpose();
          return { type: "handled" };
        case "p":
          this.historyPrev();
          return { type: "handled" };
        case "n":
          this.historyNext();
          return { type: "handled" };
        case "r":
          this.startSearch();
          return { type: "handled" };
        case "_":
          this.undo();
          return { type: "handled" };
        default:
          break;
      }
    }

    if (ev.alt && !ev.ctrl) {
      switch (ev.name) {
        case "b":
          this.moveCursor(this.wordLeft(this.cursor), "left");
          return { type: "handled" };
        case "f":
          this.moveCursor(this.wordRight(this.cursor), "right");
          return { type: "handled" };
        case "d":
          this.killWordForward();
          return { type: "handled" };
        default:
          break;
      }
    }

    return { type: "unhandled" };
  }

  // --- menu ----------------------------------------------------------------------------

  private handleMenuKey(ev: KeyEvent): EditorResult | undefined {
    const menu = this.menu;
    if (!menu) return undefined;
    const items = menu.result.items;
    const move = (delta: number): void => {
      menu.selected = (menu.selected + delta + items.length) % items.length;
      if (menu.selected < menu.first) menu.first = menu.selected;
      if (menu.selected >= menu.first + MENU_ROWS) menu.first = menu.selected - MENU_ROWS + 1;
      if (menu.selected === 0) menu.first = 0;
      if (menu.selected === items.length - 1) menu.first = Math.max(0, items.length - MENU_ROWS);
    };
    const plain = !ev.ctrl && !ev.alt && !ev.shift;

    if ((ev.name === "up" && plain) || (ev.name === "p" && ev.ctrl)) {
      move(-1);
      return { type: "handled" };
    }
    if ((ev.name === "down" && plain) || (ev.name === "n" && ev.ctrl)) {
      move(1);
      return { type: "handled" };
    }
    if (ev.name === "tab" && !ev.shift) {
      this.acceptMenuItem();
      return { type: "handled" };
    }
    if (ev.name === "return" && plain) {
      const item = items[menu.selected];
      const typed = this.text.slice(menu.result.start, menu.result.end);
      // The token is already exactly the highlighted command: Enter means "run it".
      if (item.kind === "command" && typed === item.insert) return undefined;
      this.acceptMenuItem();
      if (item.submitOnEnter && this.text.trimEnd() === item.insert) return this.submit();
      return { type: "handled" };
    }
    return undefined;
  }

  private acceptMenuItem(): void {
    const menu = this.menu;
    if (!menu) return;
    const item = menu.result.items[menu.selected];
    const { start, end } = menu.result;
    this.recordUndo("complete", true);
    const before = this.text.slice(0, start);
    let after = this.text.slice(end);
    let insert = item.insert;
    if (item.append) {
      if (after.startsWith(item.append)) after = after.slice(item.append.length);
      insert += item.append;
    }
    this.text = before + insert + after;
    this.cursor = before.length + insert.length;
    this.menuSuspended = false;
    this.afterChange();
  }

  private refreshMenu(): void {
    if (!this.completer || this.menuSuspended || this.search) {
      this.menu = undefined;
      return;
    }
    if (this.menuDismissedFor !== undefined && this.menuDismissedFor === this.text) {
      this.menu = undefined;
      return;
    }
    this.menuDismissedFor = undefined;
    const result = this.completer(this.text, this.cursor);
    if (!result || result.items.length === 0) {
      this.menu = undefined;
      return;
    }
    const same =
      this.menu && this.menu.result.items.length === result.items.length && this.menu.result.items.every((item, i) => item.label === result.items[i].label);
    this.menu = same && this.menu ? { result, selected: this.menu.selected, first: this.menu.first } : { result, selected: 0, first: 0 };
  }

  // --- editing primitives -----------------------------------------------------------

  private typeText(raw: string): void {
    const text = raw.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
    if (text.length === 0) return;
    const wordStart = /^\S/.test(text) && this.cursor > 0 && /\s/.test(this.text[this.cursor - 1] ?? "");
    this.recordUndo("insert", wordStart);
    this.replaceRange(this.cursor, this.cursor, text);
  }

  private insertText(text: string): void {
    this.recordUndo("insert-text", true);
    this.replaceRange(this.cursor, this.cursor, text);
  }

  private insertNewline(): void {
    this.recordUndo("newline", true);
    this.replaceRange(this.cursor, this.cursor, "\n");
  }

  private insertPaste(raw: string): void {
    const normalized = raw.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    if (normalized.length === 0) return;
    const rewritten = this.transformPaste?.(normalized);
    if (rewritten !== undefined) {
      this.recordUndo("paste", true);
      this.replaceRange(this.cursor, this.cursor, rewritten);
      return;
    }
    const lines = normalized.split("\n").length;
    let insert = normalized;
    if (lines > PASTE_COLLAPSE_LINES || normalized.length > PASTE_COLLAPSE_CHARS) {
      this.pasteCounter += 1;
      this.pastes.set(this.pasteCounter, normalized);
      insert = lines > 1 ? `[Pasted text #${this.pasteCounter} +${lines - 1} lines]` : `[Pasted text #${this.pasteCounter} ${normalized.length.toLocaleString("en-US")} chars]`;
    }
    this.recordUndo("paste", true);
    this.replaceRange(this.cursor, this.cursor, insert);
  }

  private deleteBack(): void {
    if (this.cursor === 0) return;
    this.recordUndo("delete-back");
    this.replaceRange(this.prev(this.cursor), this.cursor, "");
  }

  private deleteForward(): void {
    if (this.cursor >= this.text.length) return;
    this.recordUndo("delete-forward");
    this.replaceRange(this.cursor, this.next(this.cursor), "");
  }

  private kill(start: number, end: number, prepend: boolean): void {
    if (start >= end) return;
    const killed = this.text.slice(start, end);
    this.killBuffer = this.lastWasKill ? (prepend ? killed + this.killBuffer : this.killBuffer + killed) : killed;
    this.recordUndo("kill", true);
    this.replaceRange(start, end, "");
    this.lastWasKill = true;
  }

  private killToLineEnd(): void {
    const end = this.lineEnd(this.cursor);
    // At the end of a line, Ctrl+K joins with the next line (kills the newline).
    this.kill(this.cursor, end === this.cursor ? Math.min(this.text.length, end + 1) : end, false);
  }

  private killToLineStart(): void {
    const start = this.lineStart(this.cursor);
    this.kill(start === this.cursor ? Math.max(0, start - 1) : start, this.cursor, true);
  }

  private killWordBack(whitespaceDelimited = false): void {
    const start = whitespaceDelimited ? this.bigWordLeft(this.cursor) : this.wordLeft(this.cursor);
    this.kill(start, this.cursor, true);
  }

  private killWordForward(): void {
    this.kill(this.cursor, this.wordRight(this.cursor), false);
  }

  private yank(): void {
    if (this.killBuffer.length === 0) return;
    this.recordUndo("yank", true);
    this.replaceRange(this.cursor, this.cursor, this.killBuffer);
  }

  private transpose(): void {
    const units = this.units();
    if (units.length < 2) return;
    let at = units.findIndex((u) => u.end > this.cursor);
    if (at === -1) at = units.length - 1; // cursor at end: swap the last two
    if (at === 0) at = 1;
    const a = units[at - 1];
    const b = units[at];
    if (a.text === "\n" || b.text === "\n") return;
    this.recordUndo("transpose", true);
    this.text = this.text.slice(0, a.start) + b.text + a.text + this.text.slice(b.end);
    this.cursor = b.end;
    this.afterChange();
  }

  private replaceRange(start: number, end: number, insert: string): void {
    this.text = this.text.slice(0, start) + insert + this.text.slice(end);
    this.cursor = start + insert.length;
    this.historyIndex = -1;
    this.menuSuspended = false;
    this.lastWasKill = false;
    this.afterChange();
  }

  private afterChange(): void {
    this.goalColumn = undefined;
    this.unitCache = undefined;
    this.refreshMenu();
  }

  // --- undo --------------------------------------------------------------------------

  private recordUndo(kind: string, breakGroup = false): void {
    if (!breakGroup && kind === this.lastEdit) return;
    this.undoStack.push({ text: this.text, cursor: this.cursor });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.lastEdit = kind;
  }

  private undo(): void {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.text = snapshot.text;
    this.cursor = Math.min(snapshot.cursor, snapshot.text.length);
    this.lastEdit = "";
    this.lastWasKill = false;
    this.afterChange();
  }

  // --- units: grapheme clusters, with a collapsed paste counting as one ------------------

  private units(): Unit[] {
    if (this.unitCache && this.unitCache.text === this.text) return this.unitCache.units;
    const units: Unit[] = [];
    const text = this.text;
    const hasPlaceholders = text.includes("[Pasted text #");
    let index = 0;
    // Walk the text; placeholders are atomic, everything else is segmented into graphemes.
    const segments: Array<{ start: number; end: number; placeholder: boolean }> = [];
    if (hasPlaceholders) {
      for (const match of text.matchAll(PLACEHOLDER_GLOBAL)) {
        const start = match.index as number;
        if (start > index) segments.push({ start: index, end: start, placeholder: false });
        segments.push({ start, end: start + match[0].length, placeholder: true });
        index = start + match[0].length;
      }
    }
    if (index < text.length) segments.push({ start: index, end: text.length, placeholder: false });
    for (const segment of segments) {
      if (segment.placeholder) {
        units.push({ text: text.slice(segment.start, segment.end), start: segment.start, end: segment.end, placeholder: true });
        continue;
      }
      let at = segment.start;
      for (const g of graphemes(text.slice(segment.start, segment.end))) {
        units.push({ text: g, start: at, end: at + g.length, placeholder: false });
        at += g.length;
      }
    }
    this.unitCache = { text, units };
    return units;
  }

  private prev(index: number): number {
    if (index <= 0) return 0;
    const units = this.units();
    for (let i = units.length - 1; i >= 0; i -= 1) {
      if (units[i].start < index) return units[i].start;
    }
    return 0;
  }

  private next(index: number): number {
    if (index >= this.text.length) return this.text.length;
    for (const unit of this.units()) {
      if (unit.end > index) return unit.end;
    }
    return this.text.length;
  }

  private lineStart(index: number): number {
    return this.text.lastIndexOf("\n", index - 1) + 1;
  }

  private lineEnd(index: number): number {
    const at = this.text.indexOf("\n", index);
    return at === -1 ? this.text.length : at;
  }

  private classify(unit: Unit): "word" | "space" | "other" {
    if (unit.placeholder) return "word";
    if (/^\s/.test(unit.text)) return "space";
    return /^[\p{L}\p{N}_]/u.test(unit.text) ? "word" : "other";
  }

  private wordLeft(index: number): number {
    const units = this.units().filter((u) => u.end <= index);
    let i = units.length - 1;
    while (i >= 0 && this.classify(units[i]) !== "word") i -= 1;
    while (i >= 0 && this.classify(units[i]) === "word") i -= 1;
    return i + 1 >= units.length ? index : (units[i + 1]?.start ?? 0);
  }

  private wordRight(index: number): number {
    const units = this.units().filter((u) => u.start >= index);
    let i = 0;
    while (i < units.length && this.classify(units[i]) !== "word") i += 1;
    while (i < units.length && this.classify(units[i]) === "word") i += 1;
    return i === 0 ? index : (units[i - 1]?.end ?? this.text.length);
  }

  private bigWordLeft(index: number): number {
    const units = this.units().filter((u) => u.end <= index);
    let i = units.length - 1;
    while (i >= 0 && /^\s/.test(units[i].text)) i -= 1;
    while (i >= 0 && !/^\s/.test(units[i].text)) i -= 1;
    return i + 1 >= units.length ? index : (units[i + 1]?.start ?? 0);
  }

  // --- cursor movement ------------------------------------------------------------------

  private moveCursor(target: number, _direction: "left" | "right"): void {
    this.cursor = Math.max(0, Math.min(this.text.length, target));
    this.goalColumn = undefined;
    this.lastWasKill = false;
    this.lastEdit = "";
    this.refreshMenu();
  }

  private moveVertical(delta: -1 | 1): boolean {
    const rows = layoutRows(this.text, this.width);
    const cell = locate(rows, this.text, this.cursor);
    const target = cell.row + delta;
    if (target < 0 || target >= rows.length) return false;
    const goal = this.goalColumn ?? cell.col;
    this.cursor = indexAtColumn(rows, this.text, target, goal);
    this.goalColumn = goal;
    this.lastWasKill = false;
    this.lastEdit = "";
    return true;
  }

  private up(): void {
    if (this.moveVertical(-1)) return;
    this.historyPrev();
  }

  private down(): void {
    if (this.moveVertical(1)) return;
    this.historyNext();
  }

  // --- history --------------------------------------------------------------------------

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.draft = this.text;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return;
    }
    this.loadHistoryEntry(this.history[this.historyIndex]);
  }

  private historyNext(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.loadHistoryEntry(this.history[this.historyIndex]);
    } else {
      this.historyIndex = -1;
      this.loadHistoryEntry(this.draft);
    }
  }

  private loadHistoryEntry(entry: string): void {
    const index = this.historyIndex;
    this.recordUndo("history", true);
    this.text = entry;
    this.cursor = entry.length;
    this.goalColumn = undefined;
    this.lastWasKill = false;
    this.menuSuspended = true; // browsing history should not pop the slash menu
    this.afterChange();
    this.historyIndex = index;
  }

  // --- reverse search -----------------------------------------------------------------

  private startSearch(): void {
    this.search = { query: "", match: -1, saved: { text: this.text, cursor: this.cursor } };
    this.menu = undefined;
  }

  private findMatch(from: number): number {
    const search = this.search;
    if (!search || search.query.length === 0) return -1;
    const needle = search.query.toLowerCase();
    for (let i = Math.min(from, this.history.length - 1); i >= 0; i -= 1) {
      if (this.history[i].toLowerCase().includes(needle)) return i;
    }
    return -1;
  }

  private showSearchMatch(): void {
    const search = this.search;
    if (!search) return;
    if (search.match >= 0) {
      this.text = this.history[search.match];
      const at = this.text.toLowerCase().indexOf(search.query.toLowerCase());
      this.cursor = at >= 0 ? at + search.query.length : this.text.length;
    } else {
      this.text = search.saved.text;
      this.cursor = search.saved.cursor;
    }
    this.unitCache = undefined;
  }

  private handleSearchKey(ev: KeyEvent): EditorResult {
    const search = this.search as NonNullable<typeof this.search>;
    if (ev.name === "text" || ev.name === "paste") {
      search.query += (ev.text ?? "").replace(/\s+/g, " ");
      search.match = this.findMatch(this.history.length - 1);
      this.showSearchMatch();
      return { type: "handled" };
    }
    if (ev.name === "backspace") {
      search.query = search.query.slice(0, -1);
      search.match = this.findMatch(this.history.length - 1);
      this.showSearchMatch();
      return { type: "handled" };
    }
    if (ev.ctrl && ev.name === "r") {
      const older = this.findMatch((search.match === -1 ? this.history.length : search.match) - 1);
      if (older !== -1) search.match = older;
      this.showSearchMatch();
      return { type: "handled" };
    }
    if (ev.name === "escape" || (ev.ctrl && (ev.name === "c" || ev.name === "g"))) {
      this.text = search.saved.text;
      this.cursor = search.saved.cursor;
      this.search = undefined;
      this.afterChange();
      return { type: "handled" };
    }
    // Any other key accepts the match; Enter just accepts, other keys then act on it.
    const accepted = search.match >= 0;
    if (accepted) {
      // Undo returns to what was typed before the search.
      this.undoStack.push(search.saved);
      this.lastEdit = "search";
    }
    this.search = undefined;
    this.menuSuspended = true;
    this.afterChange();
    if (ev.name === "return" && !ev.shift && !ev.alt) return { type: "handled" };
    return this.handle(ev);
  }

  // --- submit -------------------------------------------------------------------------

  private submit(): EditorResult {
    // A trailing backslash before Enter continues the line instead of sending.
    if (this.cursor === this.text.length && this.text.endsWith("\\") && !this.text.endsWith("\\\\")) {
      this.recordUndo("newline", true);
      this.text = `${this.text.slice(0, -1)}\n`;
      this.cursor = this.text.length;
      this.afterChange();
      return { type: "handled" };
    }
    const display = this.text.replace(/\s+$/, "");
    if (display.trim().length === 0 && !this.allowEmpty) return { type: "handled" };
    const text = display.replace(PLACEHOLDER_GLOBAL, (whole, id: string) => this.pastes.get(Number(id)) ?? whole);
    this.addHistory(display);
    this.text = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.draft = "";
    this.undoStack = [];
    this.lastEdit = "";
    this.menu = undefined;
    this.menuDismissedFor = undefined;
    this.menuSuspended = false;
    this.unitCache = undefined;
    return { type: "submit", text, display };
  }
}
