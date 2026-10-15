/**
 * TerminalRenderer: everything the agent prints, as styled blocks.
 *
 * It owns the *look* of the transcript — the user's echo, streamed assistant text, tool
 * cards, plans, receipts, notices — and hands rows to the `Ui`, which commits them above the
 * live prompt. Content is indented two columns and separated by single blank lines so the
 * scrollback reads like a conversation.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getBannerWidth, renderBanner } from "./banner.js";
import { formatDuration, formatTokens, plural, sanitizeForDisplay } from "./fmt.js";
import type { StatusModel } from "./frame.js";
import { MarkdownStream, renderMarkdownRows } from "./markdown.js";
import type { Style } from "./style.js";
import { renderToolCard } from "./tool-view.js";
import type { Ui } from "./ui.js";
import { shortenPath } from "./frame.js";
import { truncate, wrapAnsi } from "./width.js";

const INDENT = "  ";
const MAX_CONTENT_WIDTH = 116;

const TIPS = [
  "Shift+Enter (or Ctrl+J) inserts a newline; Enter sends.",
  "Type @ to mention a file — its contents are attached to your message.",
  "Press Esc to interrupt a running task; messages you type meanwhile are queued.",
  "Shift+Tab cycles permission modes: ask → accept edits → plan.",
  "Start with `revcode --universe` to let the agent work in an isolated copy you can review and land.",
  "Ctrl+R searches your prompt history; Up and Down walk through it.",
  "Ctrl+O shows more of each tool's output.",
  "Start a line with ! to run a shell command yourself.",
  "/init writes an AGENTS.md so RevCode learns your project's conventions.",
  "/resume reopens an earlier session; /compact frees up context.",
  "Paste large text freely — it collapses to a placeholder and is sent in full.",
  "Put project rules in AGENTS.md; they are loaded into every session.",
];

type Kind = "user" | "text" | "tool" | "meta" | "block";

export interface WelcomeInfo {
  version: string;
  model: string;
  provider: string;
  cwd: string;
}

export interface TurnSummary {
  durationMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export class TerminalRenderer {
  private lastKind: Kind | undefined;
  private md: MarkdownStream | undefined;
  private verboseOutput: boolean;
  private contextPercent = 0;
  private mode = "ask";
  private modeSource: (() => string) | undefined;
  private extras: string[] = [];
  private branchCache: { cwd: string; value: string | undefined; at: number } | undefined;
  private model: string;
  private lastAssistantText = "";
  private streamText = "";

  constructor(
    private readonly cwd: string,
    model: string,
    readonly ui: Ui,
    readonly style: Style,
    options: { verbose?: boolean } = {},
  ) {
    this.model = model;
    this.verboseOutput = options.verbose ?? false;
  }

  // --- state shown in the status line ----------------------------------------------------

  updateModel(model: string): void {
    this.model = model;
    this.ui.refresh();
  }

  setMode(mode: string): void {
    this.mode = mode;
    this.ui.refresh();
  }

  /** Read the permission mode live (it can change mid-turn, e.g. "allow all edits"). */
  setModeSource(source: () => string): void {
    this.modeSource = source;
  }

  /** Extra, pre-styled status segments such as the Parallel Universe id. */
  setExtras(extras: string[]): void {
    this.extras = extras;
    this.ui.refresh();
  }

  setContextPercent(percent: number): void {
    this.contextPercent = Math.max(0, Math.min(100, Math.round(percent)));
    this.ui.refresh();
  }

  statusModel(): StatusModel {
    return {
      cwd: this.cwd,
      branch: this.gitBranch(),
      mode: this.modeSource?.() ?? this.mode,
      model: this.model,
      contextPercent: this.contextPercent,
      extra: this.extras,
    };
  }

  get verbose(): boolean {
    return this.verboseOutput;
  }

  toggleVerbose(): boolean {
    this.verboseOutput = !this.verboseOutput;
    return this.verboseOutput;
  }

  getLastAssistantText(): string {
    return this.lastAssistantText;
  }

  private gitBranch(): string | undefined {
    const now = Date.now();
    if (this.branchCache && this.branchCache.cwd === this.cwd && now - this.branchCache.at < 5000) return this.branchCache.value;
    const value = readGitBranch(this.cwd);
    this.branchCache = { cwd: this.cwd, value, at: now };
    return value;
  }

  // --- layout helpers --------------------------------------------------------------------

  contentWidth(): number {
    return Math.max(30, Math.min(MAX_CONTENT_WIDTH, this.ui.columns - INDENT.length * 2));
  }

  private indent(rows: string[]): string {
    return rows.map((row) => (row.length > 0 ? `${INDENT}${row}` : "")).join("\n");
  }

  /** Print rows as a block of `kind`, with one blank line between blocks of different kinds. */
  private emit(kind: Kind, rows: string[], options: { indent?: boolean } = {}): void {
    if (rows.length === 0) return;
    const separate = this.lastKind !== undefined && (this.lastKind !== kind || kind === "block") && !(kind === "meta" && this.lastKind === "meta");
    const body = options.indent === false ? rows.join("\n") : this.indent(rows);
    this.ui.print(separate ? `\n${body}` : body);
    this.lastKind = kind;
  }

  // --- welcome / goodbye -------------------------------------------------------------------

  welcome(info: WelcomeInfo): void {
    const { style } = this;
    const rows = this.ui.interactive ? process.stdout.rows ?? 24 : 24;
    const showBanner = this.ui.columns >= getBannerWidth() + 4 && rows >= 30;
    const lines: string[] = [""];
    if (showBanner) {
      lines.push(...renderBanner(style).map((line) => `  ${line}`));
    } else {
      lines.push(`  ${style.gradient(`${style.glyphs.prompt} RevCode`)} ${style.dim(`v${info.version}`)}`);
    }
    lines.push("");
    if (showBanner) lines.push(`  ${style.dim(`v${info.version}`)}`);
    const room = Math.max(20, this.ui.columns - info.model.length - info.provider.length - 12);
    lines.push(`  ${style.paint("accent", info.model)} ${style.dim(`(${info.provider})`)}  ${style.dim(style.glyphs.dot)}  ${style.dim(shortenPath(info.cwd, process.env.HOME, room))}`);
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
    lines.push(`  ${style.dim(`Tip: ${tip}`)}`);
    lines.push("");
    this.ui.print(lines.join("\n"));
    this.lastKind = "block";
  }

  goodbye(summary?: string): void {
    const lines = [""];
    if (summary) lines.push(`  ${this.style.dim(summary)}`);
    lines.push(`  ${this.style.dim("Bye!")}`, "");
    this.ui.print(lines.join("\n"));
  }

  // --- the conversation ----------------------------------------------------------------------

  /** Echo the user's message into the transcript. */
  echoUser(display: string): void {
    const { style } = this;
    const width = Math.max(20, this.ui.columns - 4);
    const rows = wrapAnsi(sanitizeForDisplay(display), width);
    const body = rows.map((row, i) => (i === 0 ? `${style.paint("prompt", style.glyphs.prompt)} ${style.bold(row)}` : `  ${style.bold(row)}`));
    this.ui.print(`${this.lastKind === undefined ? "" : "\n"}${body.join("\n")}`);
    this.lastKind = "user";
  }

  /** Streamed assistant text. */
  streamDelta(delta: string): void {
    if (!this.md) {
      this.md = new MarkdownStream({ style: this.style, width: this.contentWidth() });
      this.streamText = "";
      // A blank line separates the text from whatever came before it.
      if (this.lastKind !== undefined && this.lastKind !== "text") this.ui.print("");
      this.lastKind = "text";
    }
    this.streamText += delta;
    this.ui.addTokens(delta.length / 4);
    const { lines, tail } = this.md.push(delta);
    if (lines.length > 0) this.ui.print(this.indent(lines));
    this.ui.setTail(tail.length > 0 ? this.indent(tail.split("\n")) : undefined);
  }

  streamEnd(): void {
    if (!this.md) return;
    const rest = this.md.flush();
    this.md = undefined;
    this.ui.setTail(undefined);
    if (rest.length > 0) this.ui.print(this.indent(rest));
    this.lastAssistantText = this.streamText;
    this.lastKind = "text";
  }

  isStreaming(): boolean {
    return this.md !== undefined;
  }

  /** A complete (non-streamed) assistant message. */
  assistant(text: string): void {
    if (text.trim().length === 0) return;
    this.lastAssistantText = text;
    this.emit("text", renderMarkdownRows(sanitizeForDisplay(text), { style: this.style, width: this.contentWidth() }));
  }

  toolCard(call: { name: string; arguments: Record<string, unknown> }, result: unknown, durationMs?: number): void {
    const rows = renderToolCard(call, result, { style: this.style, width: this.contentWidth(), verbose: this.verboseOutput, durationMs });
    this.emit("tool", rows);
  }

  plan(steps: Array<{ step: string; status: string }>): void {
    if (steps.length === 0) return;
    const { style } = this;
    const done = steps.filter((s) => s.status === "completed").length;
    const rows = [`${style.bold(style.paint("heading", "Plan"))} ${style.dim(`${done}/${steps.length}`)}`];
    for (const { step, status } of steps) {
      const width = this.contentWidth() - 4;
      const wrapped = wrapAnsi(sanitizeForDisplay(step), width);
      const marker = status === "completed" ? style.paint("ok", style.glyphs.check) : status === "in_progress" ? style.paint("accent", "▸") : style.dim("○");
      wrapped.forEach((row, i) => {
        const text = status === "completed" ? style.dim(style.strike(row)) : status === "in_progress" ? style.bold(row) : row;
        rows.push(`  ${i === 0 ? marker : " "} ${text}`);
      });
    }
    this.emit("block", rows);
  }

  /** Boxed end-of-turn receipt. Lines starting with ⚠ or ✘ are highlighted. */
  receipt(lines: string[]): void {
    if (lines.length === 0) return;
    const { style } = this;
    const width = Math.min(this.contentWidth(), 100);
    const rule = (text: string): string => style.dim(text);
    const [tl, , bl] = style.glyphs.corner;
    const title = " receipt ";
    const rows = [rule(`${tl}${style.glyphs.rule}${title}${style.glyphs.rule.repeat(Math.max(4, width - title.length - 3))}`)];
    for (const line of lines) {
      const clean = sanitizeForDisplay(line);
      const body = clean.startsWith("⚠") || clean.startsWith("!") ? style.paint("warn", clean) : clean.startsWith("✘") ? style.paint("error", clean) : clean.startsWith("✔") ? style.paint("ok", clean) : style.dim(clean);
      for (const row of wrapAnsi(body, width - 3)) rows.push(`${rule(style.glyphs.box.v)} ${row}`);
    }
    rows.push(rule(`${bl}${style.glyphs.rule.repeat(Math.max(4, width - 1))}`));
    this.emit("block", rows);
  }

  turnSummary(summary: TurnSummary): void {
    const { style } = this;
    if (summary.toolCalls === 0 && summary.durationMs < 5000) return;
    const parts = [`Worked for ${formatDuration(summary.durationMs)}`];
    if (summary.toolCalls > 0) parts.push(plural(summary.toolCalls, "tool call"));
    const tokens = summary.inputTokens + summary.outputTokens;
    if (tokens > 0) parts.push(`${formatTokens(summary.inputTokens)} in ${style.glyphs.dot} ${formatTokens(summary.outputTokens)} out`);
    this.emit("meta", [style.dim(`${style.glyphs.bullet === "●" ? "✻" : "*"} ${parts.join(` ${style.glyphs.dot} `)}`)]);
  }

  // --- notices ------------------------------------------------------------------------------

  /** Informational text (command output). Not styled beyond what the caller did. */
  info(text: string): void {
    this.emit("meta", sanitizeForDisplay(text).split("\n"));
  }

  dimInfo(text: string): void {
    this.emit(
      "meta",
      sanitizeForDisplay(text)
        .split("\n")
        .map((line) => this.style.dim(line)),
    );
  }

  success(text: string): void {
    this.emit("meta", [`${this.style.paint("ok", this.style.glyphs.check)} ${sanitizeForDisplay(text)}`]);
  }

  warn(text: string): void {
    this.emit("meta", [`${this.style.paint("warn", this.style.glyphs.warn)} ${sanitizeForDisplay(text)}`]);
  }

  error(text: string): void {
    this.emit("meta", [`${this.style.paint("error", this.style.glyphs.cross)} ${sanitizeForDisplay(text)}`]);
  }

  /** A titled list, e.g. /help or /status. */
  section(title: string, rows: string[]): void {
    this.emit("block", [this.style.bold(this.style.paint("heading", title)), ...rows.map((r) => `  ${r}`)]);
  }

  /** Two-column key/value rows, aligned. */
  keyValues(pairs: Array<[string, string]>): string[] {
    const width = Math.max(...pairs.map(([k]) => k.length));
    return pairs.map(([k, v]) => `${this.style.dim(k.padEnd(width))}  ${v}`);
  }

  /** Text for a modal title: wraps and indents consistently. */
  modalRows(text: string): string[] {
    return wrapAnsi(sanitizeForDisplay(text), Math.max(20, this.ui.columns - 6)).map((row) => `  ${row}`);
  }

  truncateLine(text: string, max: number): string {
    return truncate(sanitizeForDisplay(text).replace(/\s+/g, " "), max);
  }
}

export function shortenHome(cwd: string): string {
  const home = process.env.HOME;
  return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Current git branch (or short SHA when detached) without spawning git. */
export function readGitBranch(cwd: string): string | undefined {
  try {
    let dir = path.resolve(cwd);
    for (let i = 0; i < 40; i += 1) {
      const gitPath = path.join(dir, ".git");
      if (existsSync(gitPath)) {
        let gitDir = gitPath;
        if (statSync(gitPath).isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, "utf8"));
          if (!pointer) return undefined;
          gitDir = path.resolve(dir, pointer[1].trim());
        }
        const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1] : head.slice(0, 7) || undefined;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
