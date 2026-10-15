/**
 * The interactive terminal UI.
 *
 * `TerminalUI` owns stdin and the live block for the whole session — not just between
 * turns — so the prompt stays visible while the agent works: you can type ahead (messages
 * queue), see what it is doing and for how long, interrupt with Esc, and answer permission
 * prompts in the same place. `PlainUI` is the same surface for pipes and dumb terminals.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { revcodeHome } from "../config/paths.js";
import { createInterface, type Interface } from "node:readline";
import { buildFrame, type ActivityModel, type FrameModel, type ModalModel, type SelectOption, type StatusModel } from "./frame.js";
import type { HistoryStore } from "./history.js";
import { LineEditor } from "./editor.js";
import { KeyParser, type KeyEvent } from "./keys.js";
import { LiveScreen, type ScreenOut } from "./screen.js";
import type { Style } from "./style.js";
import { TerminalModes, titleSequence } from "./term.js";
import { formatDuration, formatTokens } from "./fmt.js";
import { THINKING_STATUS_MESSAGES } from "./spinner.js";

export type UiInput = { type: "submit"; text: string; display: string } | { type: "eof" };

export interface SelectRequest {
  /** Rows shown above the options (already styled). */
  title: string[];
  options: SelectOption[];
  /** Single-key shortcuts → option index (digits 1-9 always work). */
  hotkeys?: Record<string, number>;
  initial?: number;
  /** Option chosen on Esc. When absent, Esc resolves `undefined`. */
  cancelIndex?: number;
  footer?: string;
}

export interface PromptRequest {
  title: string[];
  secret?: boolean;
  /** Enter on an empty line resolves "" (an optional answer). Default: an answer is required. */
  optional?: boolean;
  footer?: string;
}

export interface Ui {
  /** True for the live, redrawn UI; false for the plain line-based fallback. */
  readonly interactive: boolean;
  /** True when the terminal itself already shows what the user typed (cooked-mode line input). */
  readonly echoesInput: boolean;
  readonly columns: number;
  mount(): void;
  unmount(): void;
  nextInput(): Promise<UiInput>;
  /** Commit rows to scrollback; `text` is the rows joined with newlines ("" is one blank row). */
  print(text: string): void;
  /** Show or hide the activity line; `label` replaces the playful status word (e.g. "Starting…"). */
  setBusy(busy: boolean, label?: string): void;
  /** A short message in the status line (fades after a couple of seconds). */
  hint(text: string): void;
  /** A dim line under the activity line: what the model is thinking / what a command just printed. */
  setThought(text: string | undefined): void;
  /** The latest output line of a running command. */
  setToolOutput(text: string | undefined): void;
  /** Extra detail on the activity line, e.g. "HTTP 503 — retrying in 4s" (clears itself after `ttlMs`). */
  setNote(text: string | undefined, ttlMs?: number): void;
  beginTool(id: string, label: string): void;
  endTool(id: string): void;
  addTokens(estimate: number): void;
  setTail(text: string | undefined): void;
  /** Status data changed (mode, model, context): repaint. */
  refresh(): void;
  select(request: SelectRequest): Promise<number | undefined>;
  prompt(request: PromptRequest): Promise<string | undefined>;
  /** Ring the terminal bell (and raise a desktop notification where supported) when the window is not focused. */
  notify(message?: string): void;
  clearScreen(): void;
  /** Total time spent waiting on prompts so far, so callers can exclude it from durations. */
  modalMs(): number;
  /** Write an escape sequence that has no visible effect (clipboard, title). */
  rawWrite(sequence: string): void;
  /** Put text into the prompt (e.g. restore a message after an interrupt). */
  setInputText(text: string): void;
}

export interface UiHooks {
  /** Esc / Ctrl+C while a turn is running. */
  onInterrupt?(): void;
  /** Ctrl+C pressed twice in quick succession during a turn: give up and exit. */
  onForceExit?(): void;
  /** Shift+Tab. */
  onCycleMode?(): void;
  /** Ctrl+O. */
  onToggleVerbose?(): void;
}

export interface TerminalUiOptions {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  style: Style;
  editor: LineEditor;
  history?: HistoryStore;
  status: () => StatusModel;
  hooks?: UiHooks;
  title?: string;
  /** Draw nothing except modals (used by `revcode setup`, which has no prompt). */
  minimal?: boolean;
}

interface ActiveModal {
  model(): ModalModel;
  handle(ev: KeyEvent): void;
}

const HINT_MS = 2000;
/** Slow the spinner to one repaint a second (screen readers, slow links): REVCODE_REDUCE_MOTION=1. */
const REDUCE_MOTION = process.env.REVCODE_REDUCE_MOTION === "1";
const FORCE_EXIT_MS = 3000;
/** Silence from the model (no text, no tool activity) longer than this is flagged in the activity line. */
const STALL_MS = 20_000;

export class TerminalUI implements Ui {
  readonly interactive = true;
  readonly echoesInput = false;
  private readonly screen: LiveScreen;
  private readonly modes: TerminalModes;
  private readonly parser = new KeyParser();
  private readonly editor: LineEditor;
  private readonly style: Style;

  private mounted = false;
  private busy = false;
  private busySince = 0;
  private lastActivityAt = 0;
  private busyLabel: string | undefined;
  private flavorSeed = 0;
  private readonly tools = new Map<string, { label: string; start: number }>();
  private tokens = 0;
  private tail: string | undefined;
  private thought: string | undefined;
  private toolOutput: string | undefined;
  private queue: Array<{ text: string; display: string }> = [];
  private waiter: ((input: UiInput) => void) | undefined;
  private exitRequested = false;
  private modal: ActiveModal | undefined;
  private modalActive = false;
  private modalTotalMs = 0;
  private modalStartedAt: number | undefined;
  private modalQueue: Array<() => void> = [];
  private hintState: { text: string; until: number } | undefined;
  private noteState: { text: string; until: number } | undefined;
  private exitArmed: { key: string; until: number } | undefined;
  private lastInterruptAt = 0;
  private ticker: NodeJS.Timeout | undefined;
  private frameNo = 0;
  private focused = true;
  private redrawTimer: NodeJS.Timeout | undefined;
  private resizeTimer: NodeJS.Timeout | undefined;
  private escTimer: NodeJS.Timeout | undefined;
  private suspended = false;
  private cursorShape: string | undefined;
  private suspendKeepAlive: NodeJS.Timeout | undefined;
  private restoreConsole: (() => void) | undefined;

  constructor(private readonly options: TerminalUiOptions) {
    this.style = options.style;
    this.editor = options.editor;
    const out: ScreenOut = {
      write: (data) => options.stdout.write(data),
      get columns() {
        return options.stdout.columns;
      },
      get rows() {
        return options.stdout.rows;
      },
    };
    this.screen = new LiveScreen(out, { sync: process.env.REVCODE_NO_SYNC !== "1" });
    this.modes = new TerminalModes({ stdin: options.stdin, stdout: options.stdout });
  }

  get columns(): number {
    return this.screen.columns;
  }

  // --- lifecycle ----------------------------------------------------------------------

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.modes.enter();
    this.options.stdin.on("data", this.onData);
    this.options.stdout.on("resize", this.onResize);
    process.on("SIGCONT", this.onContinue);
    this.captureConsole();
    this.setTitle(false);
    this.redraw();
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const timer of [this.ticker, this.redrawTimer, this.resizeTimer, this.escTimer]) {
      if (timer) clearTimeout(timer);
    }
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = this.redrawTimer = this.resizeTimer = this.escTimer = undefined;
    this.screen.release();
    this.restoreConsole?.();
    this.restoreConsole = undefined;
    this.options.stdin.off("data", this.onData);
    this.options.stdout.off("resize", this.onResize);
    process.off("SIGCONT", this.onContinue);
    if (this.cursorShape !== undefined) this.options.stdout.write("\u001b[0 q");
    this.modes.leave();
    if (this.options.title) this.options.stdout.write(titleSequence(""));
  }

  // --- input --------------------------------------------------------------------------

  nextInput(): Promise<UiInput> {
    if (this.exitRequested) return Promise.resolve({ type: "eof" });
    const queued = this.queue.shift();
    if (queued) {
      this.redraw();
      return Promise.resolve({ type: "submit", ...queued });
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.redraw();
    });
  }

  setInputText(text: string): void {
    this.editor.setText(text);
    this.redraw();
  }

  private readonly onData = (chunk: string | Buffer): void => {
    const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const ev of this.parser.feed(data)) this.guarded(() => this.handleKey(ev));
    if (this.escTimer) clearTimeout(this.escTimer);
    if (this.parser.hasPending) {
      this.escTimer = setTimeout(() => {
        for (const ev of this.parser.flush()) this.guarded(() => this.handleKey(ev));
        this.redraw();
      }, 40);
    }
    this.redraw();
  };

  /** A bug in one key handler must not take the whole session down; log it and carry on. */
  private guarded(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.logFault(error);
    }
  }

  private logFault(error: unknown): void {
    try {
      const file = path.join(revcodeHome(), "tui-errors.log");
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, `${new Date().toISOString()} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    } catch {
      // nowhere to log; ignore
    }
  }

  private handleKey(ev: KeyEvent): void {
    switch (ev.name) {
      case "response":
        return;
      case "focus-in":
        this.focused = true;
        return;
      case "focus-out":
        this.focused = false;
        return;
      default:
        break;
    }
    if (this.modal) {
      this.modal.handle(ev);
      return;
    }

    if (ev.ctrl && ev.name === "c") {
      this.onCtrlC();
      return;
    }
    if (ev.ctrl && ev.name === "d" && this.editor.isEmpty() && !this.editor.searching()) {
      this.armExit("Ctrl-D");
      return;
    }
    if (ev.name === "escape" && this.busy && !this.editor.consumesEscape(true)) {
      this.interrupt();
      return;
    }
    if (ev.ctrl && ev.name === "l") {
      this.clearScreen();
      return;
    }
    if (ev.ctrl && ev.name === "z") {
      this.suspend();
      return;
    }
    if (ev.name === "tab" && ev.shift) {
      this.options.hooks?.onCycleMode?.();
      return;
    }
    if (ev.ctrl && ev.name === "o") {
      this.options.hooks?.onToggleVerbose?.();
      return;
    }

    const result = this.editor.handle(ev);
    if (result.type === "submit") {
      this.options.history?.add(result.display);
      this.hintState = undefined;
      const item = { text: result.text, display: result.display };
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = undefined;
        waiter({ type: "submit", ...item });
      } else {
        this.queue.push(item);
      }
      return;
    }
    if (result.type === "unhandled" && ev.name === "escape" && !this.editor.isEmpty() && !this.editor.isVim()) {
      this.editor.clear();
    }
  }

  private onCtrlC(): void {
    const now = Date.now();
    if (this.busy) {
      if (now - this.lastInterruptAt < FORCE_EXIT_MS) {
        this.options.hooks?.onForceExit?.();
        return;
      }
      this.interrupt();
      return;
    }
    if (!this.editor.isEmpty()) {
      this.editor.clear();
      return;
    }
    this.armExit("Ctrl-C");
  }

  private armExit(key: string): void {
    const now = Date.now();
    if (this.exitArmed && this.exitArmed.key === key && now < this.exitArmed.until) {
      this.exitArmed = undefined;
      this.exitRequested = true;
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = undefined;
        waiter({ type: "eof" });
      }
      return;
    }
    this.exitArmed = { key, until: now + HINT_MS };
    this.setHint(`Press ${key} again to exit`);
  }

  private interrupt(): void {
    this.lastInterruptAt = Date.now();
    if (this.queue.length > 0) {
      // Nothing queued behind an interrupted turn should run unseen: put it back in the prompt.
      const restored = [...this.queue.map((q) => q.display), this.editor.getText()].filter((t) => t.length > 0).join("\n");
      this.queue = [];
      this.editor.setText(restored);
    }
    this.setHint("Interrupting…");
    this.options.hooks?.onInterrupt?.();
  }

  /** Ctrl+Z: hand the terminal back to the shell, stop, and take it again on `fg`. */
  private suspend(): void {
    if (process.platform === "win32" || this.suspended) return;
    this.suspended = true;
    this.screen.release();
    this.modes.leave();
    // With raw input off and stdin paused nothing else keeps the event loop alive.
    this.suspendKeepAlive = setInterval(() => undefined, 1000);
    process.kill(process.pid, "SIGTSTP");
    // If the stop was ignored (an orphaned process group, some sandboxes) we are still running:
    // take the terminal back instead of sitting in a dead UI. After a real stop this timer fires
    // only once we have been continued, when resuming is a no-op.
    setTimeout(() => this.resume(), 250).unref();
  }

  private resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.suspendKeepAlive) clearInterval(this.suspendKeepAlive);
    this.suspendKeepAlive = undefined;
    if (!this.mounted) return;
    this.modes.enter();
    this.redraw();
  }

  private readonly onContinue = (): void => this.resume();

  // --- output -------------------------------------------------------------------------

  print(text: string): void {
    if (!this.mounted) {
      this.options.stdout.write(`${text}\n`);
      return;
    }
    this.screen.print(text, this.frame());
  }

  modalMs(): number {
    return this.modalTotalMs + (this.modalStartedAt === undefined ? 0 : Date.now() - this.modalStartedAt);
  }

  rawWrite(sequence: string): void {
    this.options.stdout.write(sequence);
  }

  clearScreen(): void {
    if (!this.mounted) return;
    this.screen.release();
    this.options.stdout.write("\u001b[2J\u001b[3J\u001b[H");
    this.redraw();
  }

  notify(message?: string): void {
    if (this.focused || !this.mounted) return;
    const program = process.env.TERM_PROGRAM;
    const desktop = message && (program === "iTerm.app" || program === "WezTerm" || program === "ghostty") ? `\u001b]9;${message.replace(/[\u0000-\u001f]/g, " ")}\u0007` : "";
    this.options.stdout.write(`\u0007${desktop}`);
  }

  refresh(): void {
    this.scheduleRedraw();
  }

  setTail(text: string | undefined): void {
    this.tail = text && text.length > 0 ? text : undefined;
    this.scheduleRedraw();
  }

  addTokens(estimate: number): void {
    this.tokens += estimate;
    this.lastActivityAt = Date.now();
  }

  // --- activity -----------------------------------------------------------------------

  setBusy(busy: boolean, label?: string): void {
    this.busyLabel = busy ? label : undefined;
    if (busy === this.busy) {
      this.redraw();
      return;
    }
    this.busy = busy;
    if (busy) {
      this.busySince = Date.now();
      this.lastActivityAt = this.busySince;
      this.tokens = 0;
      this.tools.clear();
      this.flavorSeed = Math.floor(Math.random() * THINKING_STATUS_MESSAGES.length);
    } else {
      this.tools.clear();
      this.tail = undefined;
      this.thought = undefined;
      this.toolOutput = undefined;
      if (this.hintState?.text === "Interrupting…") this.hintState = undefined;
    }
    this.setTitle(busy);
    this.ensureTicker();
    this.redraw();
  }

  beginTool(id: string, label: string): void {
    this.lastActivityAt = Date.now();
    this.tools.set(id, { label, start: Date.now() });
    this.scheduleRedraw();
  }

  endTool(id: string): void {
    this.lastActivityAt = Date.now();
    this.tools.delete(id);
    if (this.tools.size === 0) this.toolOutput = undefined;
    this.scheduleRedraw();
  }

  hint(text: string): void {
    this.setHint(text);
    this.redraw();
  }

  setThought(text: string | undefined): void {
    this.thought = text && text.length > 0 ? text : undefined;
    this.scheduleRedraw();
  }

  setToolOutput(text: string | undefined): void {
    this.toolOutput = text && text.length > 0 ? text : undefined;
    if (text) this.lastActivityAt = Date.now();
    this.scheduleRedraw();
  }

  setNote(text: string | undefined, ttlMs = 5000): void {
    this.noteState = text ? { text, until: Date.now() + ttlMs } : undefined;
    this.ensureTicker();
    this.scheduleRedraw();
  }

  private setHint(text: string): void {
    this.hintState = { text, until: Date.now() + HINT_MS };
    this.ensureTicker();
  }

  private ensureTicker(): void {
    const needed = this.busy || this.hintState !== undefined || this.noteState !== undefined;
    if (needed && !this.ticker) {
      this.ticker = setInterval(() => {
        this.frameNo += 1;
        if (this.hintState && Date.now() >= this.hintState.until) this.hintState = undefined;
        if (this.noteState && Date.now() >= this.noteState.until) this.noteState = undefined;
        if (!this.busy && !this.hintState) this.ensureTicker();
        this.redraw();
      }, REDUCE_MOTION ? 1000 : 90);
      this.ticker.unref();
    } else if (!needed && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private activity(now: number): ActivityModel | undefined {
    if (this.modal && this.busy) {
      return { label: "Waiting for your answer", meta: "", mode: "wait", frame: this.frameNo };
    }
    if (!this.busy) return undefined;
    const elapsed = now - this.busySince;
    const dot = ` ${this.style.glyphs.dot} `;
    const interrupting = this.hintState?.text === "Interrupting…";
    const first = this.tools.values().next().value as { label: string; start: number } | undefined;
    if (first) {
      const more = this.tools.size > 1 ? ` (+${this.tools.size - 1} more)` : "";
      const parts = [formatDuration(now - first.start)];
      if (!interrupting) parts.push("esc to interrupt");
      return { label: `${first.label}${more}`, meta: parts.join(dot), mode: "spin", frame: this.frameNo };
    }
    const word = this.busyLabel ?? THINKING_STATUS_MESSAGES[(this.flavorSeed + Math.floor(elapsed / 9000)) % THINKING_STATUS_MESSAGES.length];
    const parts = [formatDuration(elapsed)];
    if (this.tokens > 0) parts.push(`${this.style.glyphs.down} ${formatTokens(this.tokens)} tokens`);
    const quiet = now - this.lastActivityAt;
    const note = this.noteState && this.noteState.until > now ? this.noteState.text : undefined;
    if (note) parts.push(note);
    else if (quiet > STALL_MS) parts.push(`no output for ${formatDuration(quiet)}`);
    if (!interrupting) parts.push("esc to interrupt");
    return { label: word, meta: parts.join(dot), mode: "spin", frame: this.frameNo, stalled: quiet > STALL_MS || note !== undefined };
  }

  private setTitle(working: boolean): void {
    if (!this.options.title || !this.mounted) return;
    this.options.stdout.write(titleSequence(`${working ? "✳ " : ""}${this.options.title}`));
  }

  // --- modals -------------------------------------------------------------------------

  select(request: SelectRequest): Promise<number | undefined> {
    return this.runModal(
      () =>
        new Promise<number | undefined>((resolve) => {
          let selected = Math.max(0, Math.min(request.options.length - 1, request.initial ?? 0));
          const finish = (value: number | undefined): void => {
            this.modal = undefined;
            resolve(value);
          };
          this.modal = {
            model: () => ({ kind: "select", title: request.title, options: request.options, selected, footer: request.footer ?? "↑↓ to move · enter to select · esc to cancel" }),
            handle: (ev) => {
              const count = request.options.length;
              if (ev.name === "up" || (ev.ctrl && ev.name === "p") || (ev.name === "tab" && ev.shift)) selected = (selected - 1 + count) % count;
              else if (ev.name === "down" || (ev.ctrl && ev.name === "n") || (ev.name === "tab" && !ev.shift)) selected = (selected + 1) % count;
              else if (ev.name === "return") finish(selected);
              else if (ev.name === "escape" || (ev.ctrl && ev.name === "c")) finish(request.cancelIndex);
              else if (ev.name === "text" && ev.text && ev.text.length === 1 && !ev.ctrl && !ev.alt) {
                const key = ev.text.toLowerCase();
                const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : undefined;
                const mapped = request.hotkeys?.[key] ?? digit;
                if (mapped !== undefined && mapped < count) finish(mapped);
              }
            },
          };
          this.notify();
          this.redraw();
        }),
    );
  }

  prompt(request: PromptRequest): Promise<string | undefined> {
    return this.runModal(
      () =>
        new Promise<string | undefined>((resolve) => {
          const editor = new LineEditor({ allowEmpty: request.optional ?? false });
          const finish = (value: string | undefined): void => {
            this.modal = undefined;
            resolve(value);
          };
          this.modal = {
            model: () => ({ kind: "input", title: request.title, editor, secret: request.secret ?? false, footer: request.footer ?? "enter to submit · esc to cancel" }),
            handle: (ev) => {
              if (ev.name === "escape" || (ev.ctrl && ev.name === "c")) {
                finish(undefined);
                return;
              }
              const result = editor.handle(ev);
              if (result.type === "submit") finish(result.text);
            },
          };
          this.notify();
          this.redraw();
        }),
    );
  }

  /** Modals run one at a time; the first starts immediately so keystrokes reach it at once. */
  private runModal<T>(start: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        this.modalActive = true;
        this.modalStartedAt = Date.now();
        start().then(resolve, reject).finally(() => {
          this.modalTotalMs += Date.now() - (this.modalStartedAt ?? Date.now());
          this.modalStartedAt = undefined;
          this.modalActive = false;
          const next = this.modalQueue.shift();
          if (next) next();
          else this.redraw();
        });
      };
      if (this.modalActive) this.modalQueue.push(run);
      else run();
    });
  }

  // --- drawing ------------------------------------------------------------------------

  private frameModel(): FrameModel {
    const now = Date.now();
    return {
      cols: this.screen.columns,
      rows: this.screen.rows,
      tail: this.tail,
      activity: this.activity(now),
      detail: this.tools.size > 0 ? this.toolOutput : this.tail ? undefined : this.thought,
      queue: this.queue.map((q) => q.display),
      editor: this.editor,
      vim: this.editor.vimModeName(),
      placeholder: this.busy ? "Type to queue a message…" : "Ask RevCode…   / for commands · @ for files · shift+enter for a new line",
      minimal: this.options.minimal,
      status: this.options.status(),
      hint: this.hintState && this.hintState.until > now ? this.hintState.text : undefined,
      modal: this.modal?.model(),
    };
  }

  private frame(): ReturnType<typeof buildFrame> {
    return buildFrame(this.frameModel(), this.style);
  }

  private redraw(): void {
    if (!this.mounted) return;
    if (this.redrawTimer) {
      clearTimeout(this.redrawTimer);
      this.redrawTimer = undefined;
    }
    try {
      this.screen.draw(this.frame());
      this.syncCursorShape();
    } catch (error) {
      this.logFault(error);
    }
  }

  /** Vim mode: a block cursor in normal mode, a bar in insert mode. */
  private syncCursorShape(): void {
    const mode = this.editor.vimModeName();
    const shape = mode === undefined ? undefined : mode === "NORMAL" ? "\u001b[2 q" : "\u001b[6 q";
    if (shape === this.cursorShape) return;
    this.cursorShape = shape;
    this.options.stdout.write(shape ?? "\u001b[0 q");
  }

  /** Coalesce bursts (streaming tokens) into at most one repaint per ~16ms. */
  private scheduleRedraw(): void {
    if (!this.mounted || this.redrawTimer) return;
    this.redrawTimer = setTimeout(() => {
      this.redrawTimer = undefined;
      this.redraw();
    }, 16);
  }

  private readonly onResize = (): void => {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      if (!this.mounted) return;
      this.screen.beginResize();
      this.redraw();
    }, 30);
  };

  // --- console capture ----------------------------------------------------------------

  /** Route stray console / stderr output through the live region so it cannot corrupt it. */
  private captureConsole(): void {
    const originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    const stderrWrite = process.stderr.write.bind(process.stderr);
    let inside = false;
    const route =
      (fallback: (...args: unknown[]) => void) =>
      (...args: unknown[]): void => {
        if (inside) return fallback(...args);
        inside = true;
        try {
          this.print(format(...args).replace(/\n$/, ""));
        } finally {
          inside = false;
        }
      };
    console.log = route(originals.log);
    console.info = route(originals.info);
    console.warn = route(originals.warn);
    console.error = route(originals.error);
    console.debug = route(originals.debug);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (inside) return (stderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      inside = true;
      try {
        this.print((typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")).replace(/\r?\n$/, ""));
      } finally {
        inside = false;
      }
      const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
      cb?.();
      return true;
    }) as typeof process.stderr.write;
    this.restoreConsole = () => {
      Object.assign(console, originals);
      process.stderr.write = stderrWrite as typeof process.stderr.write;
    };
  }
}

/** Line-based fallback for pipes, `TERM=dumb`, and anything that is not a capable TTY. */
export class PlainUI implements Ui {
  readonly interactive = false;
  readonly echoesInput: boolean;
  private rl: Interface | undefined;
  private lines: AsyncIterator<string> | undefined;

  constructor(
    private readonly options: { stdin: NodeJS.ReadableStream & { isTTY?: boolean }; stdout: { write(data: string): unknown }; columns?: number; promptText?: string },
  ) {
    this.echoesInput = Boolean(options.stdin.isTTY);
  }

  get columns(): number {
    return this.options.columns ?? 100;
  }

  mount(): void {
    if (this.rl) return;
    this.rl = createInterface({ input: this.options.stdin, terminal: false });
    this.lines = this.rl[Symbol.asyncIterator]();
  }

  unmount(): void {
    this.rl?.close();
    this.rl = undefined;
    this.lines = undefined;
  }

  async nextInput(): Promise<UiInput> {
    this.mount();
    const prompt = this.echoesInput ? (this.options.promptText ?? "> ") : "";
    this.options.stdout.write(prompt);
    while (this.lines) {
      const next = await this.lines.next();
      if (next.done) return { type: "eof" };
      const text = next.value.trim();
      if (text.length > 0) return { type: "submit", text, display: text };
      this.options.stdout.write(prompt);
    }
    return { type: "eof" };
  }

  print(text: string): void {
    this.options.stdout.write(`${text}\n`);
  }

  setBusy(): void {}
  hint(): void {}
  setNote(): void {}
  setThought(): void {}
  setToolOutput(): void {}
  beginTool(): void {}
  endTool(): void {}
  addTokens(): void {}
  setTail(): void {}
  refresh(): void {}
  notify(): void {}
  clearScreen(): void {}
  modalMs(): number {
    return 0;
  }
  rawWrite(sequence: string): void {
    this.options.stdout.write(sequence);
  }
  setInputText(): void {}

  async select(): Promise<number | undefined> {
    return undefined;
  }

  async prompt(): Promise<string | undefined> {
    return undefined;
  }
}
