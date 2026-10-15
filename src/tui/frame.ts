/**
 * Frame builder: turns the UI's state into the rows of the live block. Pure — given a model,
 * a style and a terminal size it returns the lines and where the cursor goes — so the whole
 * look of the prompt area is unit-testable without a terminal.
 */

import type { LineEditor, MenuView } from "./editor.js";
import type { Frame } from "./screen.js";
import type { Role, Style } from "./style.js";
import { clip, padEnd, truncate, visibleWidth, wrapAnsi } from "./width.js";

export interface ActivityModel {
  /** Main text, e.g. "Pondering…" or "Running shell: npm test…". */
  label: string;
  /** Dim trailing details, e.g. "12s · ↓ 1.2k tokens". */
  meta: string;
  /** "spin" animates; "wait" shows a static marker (waiting for the user). */
  mode: "spin" | "wait";
  frame: number;
  /** No output for a while: the meta text is shown as a warning. */
  stalled?: boolean;
}

export interface StatusModel {
  cwd: string;
  branch?: string;
  mode: string;
  model: string;
  contextPercent: number;
  /** Extra left-hand segments, already styled (e.g. universe id). */
  extra: string[];
}

export interface SelectOption {
  label: string;
  /** Dim text after the label. */
  hint?: string;
}

export type ModalModel =
  | {
      kind: "select";
      /** Rows shown above the options (already styled). */
      title: string[];
      options: SelectOption[];
      selected: number;
      footer?: string;
    }
  | {
      kind: "input";
      title: string[];
      editor: LineEditor;
      secret: boolean;
      footer?: string;
    };

export interface FrameModel {
  cols: number;
  rows: number;
  tail?: string;
  activity?: ActivityModel;
  queue: string[];
  editor: LineEditor;
  placeholder: string;
  status: StatusModel;
  hint?: string;
  modal?: ModalModel;
  /** Draw only the modal (nothing while no modal is open). */
  minimal?: boolean;
}

const MODE_ROLE: Record<string, Role | undefined> = {
  "accept-edits": "accent",
  plan: "ok",
  yolo: "warn",
};

const MODE_LABEL: Record<string, string> = {
  ask: "ask before changes",
  "accept-edits": "accept edits",
  plan: "plan · read-only",
  yolo: "yolo · no prompts",
};

const PREFIX_WIDTH = 2;

export function buildFrame(model: FrameModel, style: Style): Frame {
  const { cols, rows } = model;
  const lines: string[] = [];
  const compact = rows < 12;

  // Streaming tail (text of the line being written, not yet committed to scrollback).
  if (model.tail && !compact) {
    const wrapped = wrapAnsi(model.tail, Math.max(10, cols - 2));
    const keep = Math.max(1, Math.min(6, Math.floor(rows / 4)));
    const shown = wrapped.length > keep ? wrapped.slice(-keep) : wrapped;
    for (const row of shown) lines.push(row);
  }

  if (model.activity) {
    lines.push("");
    lines.push(activityLine(model.activity, style, cols));
  }

  let cursor: Frame["cursor"];

  if (model.minimal && !model.modal) return { lines: [] };

  if (model.modal) {
    const modalFrame = modalLines(model.modal, style, cols, rows - lines.length - 2);
    const offset = lines.length;
    lines.push(...modalFrame.lines);
    if (modalFrame.cursor) cursor = { row: offset + modalFrame.cursor.row, col: modalFrame.cursor.col };
  } else {
    if (model.queue.length > 0 && !compact) {
      const shown = model.queue.slice(0, 3);
      for (const queued of shown) {
        lines.push(style.dim(`  ${style.glyphs.queued} ${truncate(queued.replace(/\s+/g, " "), Math.max(10, cols - 8))}`));
      }
      if (model.queue.length > shown.length) lines.push(style.dim(`  +${model.queue.length - shown.length} more queued`));
    }

    const input = inputBox(model, style);
    const offset = lines.length;
    lines.push(...input.lines);
    cursor = { row: offset + input.cursor.row, col: input.cursor.col };

    const menu = model.editor.menuView();
    if (menu && !compact) lines.push(...menuLines(menu, style, cols, rows));
  }

  if (!model.minimal && (!compact || model.hint)) lines.push(statusLine(model, style));
  return { lines, cursor };
}

// --- activity ---------------------------------------------------------------------------

function activityLine(activity: ActivityModel, style: Style, cols: number): string {
  const marker =
    activity.mode === "spin" ? style.paint("accent", style.glyphs.spinner[activity.frame % style.glyphs.spinner.length]) : style.paint("warn", "?");
  const meta = activity.meta ? `  ${activity.stalled ? style.paint("warn", activity.meta) : style.dim(activity.meta)}` : "";
  return truncate(`${marker} ${activity.label}${meta}`, Math.max(10, cols - 1));
}

// --- input box --------------------------------------------------------------------------

function modeStyle(style: Style, mode: string): (text: string) => string {
  const role = MODE_ROLE[mode];
  return role ? (text) => style.paint(role, text) : (text) => style.dim(text);
}

function inputBox(model: FrameModel, style: Style): { lines: string[]; cursor: { row: number; col: number } } {
  const { cols, rows, editor } = model;
  const ruleWidth = Math.max(10, cols - 1);
  const paint = modeStyle(style, model.status.mode);
  const textWidth = Math.max(8, cols - PREFIX_WIDTH - 2);
  const maxRows = Math.max(1, Math.min(10, Math.floor(rows / 3)));
  const view = editor.view(textWidth, maxRows);
  const shell = editor.getText().startsWith("!");

  let top = paint(style.glyphs.rule.repeat(ruleWidth));
  if (view.search) {
    const label = view.search.failed ? ` search: "${view.search.query}" (no match) ` : ` search: "${view.search.query}" `;
    top = paint(`${style.glyphs.rule.repeat(2)}${label}${style.glyphs.rule.repeat(Math.max(0, ruleWidth - visibleWidth(label) - 2))}`);
  } else if (view.hiddenAbove > 0) {
    const label = ` ${style.glyphs.up} ${view.hiddenAbove} more `;
    top = paint(`${style.glyphs.rule.repeat(2)}${label}${style.glyphs.rule.repeat(Math.max(0, ruleWidth - visibleWidth(label) - 2))}`);
  }
  let bottom = paint(style.glyphs.rule.repeat(ruleWidth));
  if (view.hiddenBelow > 0) {
    const label = ` ${style.glyphs.down} ${view.hiddenBelow} more `;
    bottom = paint(`${style.glyphs.rule.repeat(2)}${label}${style.glyphs.rule.repeat(Math.max(0, ruleWidth - visibleWidth(label) - 2))}`);
  }

  const prompt = shell ? style.paint("warn", "!") : style.paint("prompt", style.glyphs.prompt);
  const lines: string[] = [top];
  const empty = editor.isEmpty();
  view.rows.forEach((row, index) => {
    const lead = index === 0 && view.hiddenAbove === 0 ? `${prompt} ` : "  ";
    if (empty && index === 0) {
      lines.push(`${lead}${style.dim(truncate(model.placeholder, textWidth))}`);
    } else {
      lines.push(`${lead}${highlightInput(row, index === 0 && view.hiddenAbove === 0, style)}`);
    }
  });
  lines.push(bottom);
  return { lines, cursor: { row: 1 + view.cursor.row, col: PREFIX_WIDTH + view.cursor.col } };
}

const MENTION = /(^|\s)(@[^\s]+)/g;
const PLACEHOLDER = /\[Pasted text #\d+[^\]]*\]/g;

function highlightInput(row: string, first: boolean, style: Style): string {
  if (!style.color) return row;
  let out = row;
  out = out.replace(PLACEHOLDER, (m) => style.paint("accent", m));
  out = out.replace(MENTION, (_m, lead: string, mention: string) => `${lead}${style.paint("accent", mention)}`);
  if (first && out.startsWith("/")) {
    const space = out.search(/\s/);
    const end = space === -1 ? out.length : space;
    out = `${style.paint("accent", out.slice(0, end))}${out.slice(end)}`;
  }
  return out;
}

// --- completion menu ----------------------------------------------------------------------

function menuLines(menu: MenuView, style: Style, cols: number, rows: number): string[] {
  const limit = rows < 20 ? 4 : menu.count;
  const count = Math.min(menu.count, limit);
  let first = menu.first;
  if (menu.selected >= first + count) first = menu.selected - count + 1;
  const shown = menu.items.slice(first, first + count);
  const labelWidth = Math.min(32, Math.max(8, ...shown.map((item) => visibleWidth(item.label))));
  const out: string[] = [];
  shown.forEach((item, i) => {
    const selected = first + i === menu.selected;
    const pointer = selected ? style.paint("prompt", style.glyphs.pointer) : " ";
    const label = padEnd(truncate(item.label, labelWidth), labelWidth);
    const labelText = selected ? style.strong("accent", label) : style.paint("accent", label);
    const room = Math.max(0, cols - 1 - 2 - labelWidth - 2);
    const description = item.description && room > 6 ? `  ${style.dim(truncate(item.description, room))}` : "";
    out.push(`${pointer} ${labelText}${description}`);
  });
  if (menu.total > shown.length) {
    out.push(style.dim(`  ${menu.selected + 1}/${menu.total} · ↑↓ navigate · tab accept · esc dismiss`.replace(/↑↓/g, `${style.glyphs.up}${style.glyphs.down}`)));
  }
  return out;
}

// --- status line ---------------------------------------------------------------------------

export function shortenPath(cwd: string, home: string | undefined, max: number): string {
  let p = cwd;
  if (home && (p === home || p.startsWith(`${home}/`))) p = `~${p.slice(home.length)}`;
  if (p.length <= max) return p;
  const parts = p.split("/");
  while (parts.length > 2 && `…/${parts.join("/")}`.length > max) parts.shift();
  const joined = `…/${parts.join("/")}`;
  return joined.length > max ? `…${joined.slice(-(max - 1))}` : joined;
}

function statusLine(model: FrameModel, style: Style): string {
  const { cols, status } = model;
  const width = Math.max(10, cols - 1);
  const paint = modeStyle(style, status.mode);

  let left: string;
  if (model.hint) {
    left = style.paint("warn", model.hint);
  } else {
    const label = MODE_LABEL[status.mode] ?? status.mode;
    left = paint(label);
    if (status.mode === "ask" && width >= 100) left += style.dim("  (shift+tab to change)");
    for (const extra of status.extra) left += `  ${extra}`;
  }

  const ctxText = status.contextPercent > 0 ? `${status.contextPercent}% ctx` : "";
  const ctx = status.contextPercent >= 90 ? style.paint("error", ctxText) : status.contextPercent >= 70 ? style.paint("warn", ctxText) : style.dim(ctxText);
  const sep = style.dim(` ${style.glyphs.dot} `);
  const leftWidth = visibleWidth(left);

  const build = (cwdMax: number, withModel: boolean): string => {
    const parts: string[] = [];
    const where = shortenPath(status.cwd, process.env.HOME, cwdMax) + (status.branch ? ` (${status.branch})` : "");
    if (cwdMax > 0) parts.push(style.dim(where));
    if (withModel) parts.push(style.dim(status.model));
    if (ctxText) parts.push(ctx);
    return parts.join(sep);
  };

  for (const [cwdMax, withModel] of [
    [40, true],
    [24, true],
    [0, true],
    [0, false],
  ] as const) {
    const right = build(cwdMax, withModel);
    if (leftWidth + 2 + visibleWidth(right) <= width) {
      return `${left}${" ".repeat(Math.max(2, width - leftWidth - visibleWidth(right)))}${right}`;
    }
  }
  return clip(left, width);
}

// --- modals ---------------------------------------------------------------------------------

function modalLines(modal: ModalModel, style: Style, cols: number, budget: number): { lines: string[]; cursor?: { row: number; col: number } } {
  const ruleWidth = Math.max(10, cols - 1);
  const rule = style.paint("accent", style.glyphs.rule.repeat(ruleWidth));
  const lines: string[] = [rule];

  const titleBudget = Math.max(2, budget - (modal.kind === "select" ? modal.options.length : 2) - 3);
  const title = modal.title.length > titleBudget ? [...modal.title.slice(0, titleBudget - 1), style.dim(`  ${style.glyphs.ellipsis} ${modal.title.length - titleBudget + 1} more lines`)] : modal.title;
  lines.push(...title);

  if (modal.kind === "select") {
    const labelWidth = modal.options.some((o) => o.hint) ? Math.min(44, Math.max(...modal.options.map((o) => visibleWidth(o.label)))) : 0;
    modal.options.forEach((option, index) => {
      const selected = index === modal.selected;
      const pointer = selected ? style.paint("prompt", style.glyphs.pointer) : " ";
      const number = `${index + 1}.`;
      const text = `${number} ${option.hint ? padEnd(option.label, labelWidth) : option.label}`;
      const hint = option.hint ? `  ${style.dim(option.hint)}` : "";
      lines.push(truncate(`${pointer} ${selected ? style.strong("accent", text) : text}${hint}`, ruleWidth));
    });
    if (modal.footer) lines.push(style.dim(`  ${modal.footer}`));
    return { lines };
  }

  const textWidth = Math.max(8, cols - PREFIX_WIDTH - 2);
  const view = modal.editor.view(textWidth, 4);
  const shown = modal.secret ? view.rows.map((row) => "•".repeat(visibleWidth(row))) : view.rows;
  const offset = lines.length;
  shown.forEach((row, index) => lines.push(`${index === 0 ? `${style.paint("prompt", style.glyphs.prompt)} ` : "  "}${row}`));
  if (modal.footer) lines.push(style.dim(`  ${modal.footer}`));
  return { lines, cursor: { row: offset + view.cursor.row, col: PREFIX_WIDTH + view.cursor.col } };
}
