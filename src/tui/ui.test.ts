import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { MiniTerminal } from "../testing/mini-terminal.js";
import { LineEditor } from "./editor.js";
import { plainStyle } from "./style.js";
import { createCompleter } from "./completion.js";
import { TerminalUI, type UiHooks } from "./ui.js";

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(on: boolean): this {
    this.isRaw = on;
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  type(data: string): void {
    this.emit("data", data);
  }
}

function setup(options: { cols?: number; rows?: number; hooks?: UiHooks } = {}) {
  const term = new MiniTerminal(options.cols ?? 60, options.rows ?? 16);
  const stdout = new EventEmitter() as EventEmitter & { isTTY: boolean; columns: number; rows: number; write(data: string): boolean };
  stdout.isTTY = true;
  Object.defineProperty(stdout, "columns", { get: () => term.cols });
  Object.defineProperty(stdout, "rows", { get: () => term.rows });
  stdout.write = (data: string) => {
    term.write(data);
    return true;
  };
  const stdin = new FakeStdin();
  const editor = new LineEditor({
    completer: createCompleter({ commands: () => [{ command: "/help", description: "Show help" }, { command: "/model", description: "Switch model", args: "[name]" }] }),
  });
  const ui = new TerminalUI({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    style: plainStyle(),
    editor,
    status: () => ({ cwd: "/work/proj", mode: "ask", model: "glm-5.2", contextPercent: 12, extra: [] }),
    hooks: options.hooks,
  });
  return { term, stdin, stdout, ui, editor };
}

const screen = (term: MiniTerminal): string => term.lines().join("\n");
/** A lone Esc is held briefly to tell it from the start of an escape sequence. */
const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("TerminalUI", () => {
  it("mounts a prompt box with a status line and puts the terminal in raw mode", () => {
    const { term, stdin, ui } = setup();
    ui.mount();
    expect(stdin.isRaw).toBe(true);
    const lines = term.lines();
    expect(lines[0]).toMatch(/^─+$/);
    expect(lines[1]).toContain("❯ Ask RevCode");
    expect(lines[2]).toMatch(/^─+$/);
    expect(lines[3]).toContain("ask before changes");
    expect(lines[3]).toContain("glm-5.2");
    expect(lines[3]).toContain("12% ctx");
    ui.unmount();
    expect(stdin.isRaw).toBe(false);
  });

  it("enables and disables bracketed paste, focus reporting and the kitty keyboard protocol", () => {
    const writes: string[] = [];
    const { stdout, ui } = setup();
    const original = stdout.write.bind(stdout);
    stdout.write = (data: string) => {
      writes.push(data);
      return original(data);
    };
    ui.mount();
    ui.unmount();
    const all = writes.join("");
    expect(all).toContain("\u001b[?2004h");
    expect(all).toContain("\u001b[?1004h");
    expect(all).toContain("\u001b[>1u");
    expect(all).toContain("\u001b[<u");
    expect(all).toContain("\u001b[?2004l");
  });

  it("shows typed text and resolves nextInput on Enter", async () => {
    const { term, stdin, ui } = setup();
    ui.mount();
    const pending = ui.nextInput();
    stdin.type("fix the bug");
    expect(term.lines()[1]).toContain("❯ fix the bug");
    stdin.type("\r");
    await expect(pending).resolves.toEqual({ type: "submit", text: "fix the bug", display: "fix the bug" });
    expect(term.lines()[1]).toContain("Ask RevCode");
    ui.unmount();
  });

  it("keeps the prompt visible while busy and queues messages typed ahead", async () => {
    const { term, stdin, ui } = setup();
    ui.mount();
    ui.setBusy(true);
    expect(screen(term)).toContain("esc to interrupt");
    stdin.type("then add tests");
    stdin.type("\r");
    expect(screen(term)).toContain("then add tests");
    expect(screen(term)).toMatch(/⏎ then add tests/);
    ui.setBusy(false);
    await expect(ui.nextInput()).resolves.toMatchObject({ type: "submit", text: "then add tests" });
    expect(screen(term)).not.toMatch(/⏎/);
    ui.unmount();
  });

  it("Esc interrupts a running turn and returns queued messages to the prompt", async () => {
    const onInterrupt = vi.fn();
    const { stdin, ui, editor } = setup({ hooks: { onInterrupt } });
    ui.mount();
    ui.setBusy(true);
    stdin.type("queued one");
    stdin.type("\r");
    stdin.type("\x1b");
    await settle();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("queued one");
    ui.unmount();
  });

  it("a stale interrupt does not turn the next turn's first Ctrl+C into a force exit", () => {
    const onInterrupt = vi.fn();
    const onForceExit = vi.fn();
    const { stdin, ui } = setup({ hooks: { onInterrupt, onForceExit } });
    ui.mount();
    ui.setBusy(true);
    stdin.type("\x03");
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    ui.setBusy(false);
    ui.setBusy(true);
    stdin.type("\x03");
    expect(onInterrupt).toHaveBeenCalledTimes(2);
    expect(onForceExit).not.toHaveBeenCalled();
    stdin.type("\x03"); // a second press during the same turn still forces the exit
    expect(onForceExit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it("Ctrl+D while a task runs neither exits nor disturbs the queue", async () => {
    const onForceExit = vi.fn();
    const { stdin, ui } = setup({ hooks: { onForceExit } });
    ui.mount();
    ui.setBusy(true);
    stdin.type("queued");
    stdin.type("\r");
    stdin.type("\x04");
    stdin.type("\x04");
    expect(onForceExit).not.toHaveBeenCalled();
    ui.setBusy(false);
    await expect(ui.nextInput()).resolves.toMatchObject({ type: "submit", text: "queued" });
    ui.unmount();
  });

  it("Ctrl+C leaves history search instead of clearing or exiting", () => {
    const { stdin, ui, editor } = setup();
    ui.mount();
    stdin.type("draft");
    stdin.type("\x12"); // Ctrl+R
    expect(editor.searching()).toBe(true);
    stdin.type("\x03");
    expect(editor.searching()).toBe(false);
    expect(editor.getText()).toBe("draft");
    ui.unmount();
  });

  it("holds a bracketed paste together even when the idle timer fires mid-paste", async () => {
    const { stdin, ui, editor } = setup({ rows: 20 });
    ui.mount();
    stdin.type("\x1b[200~first half\n");
    await settle();
    stdin.type("second half\x1b[201~");
    expect(editor.getText().replace(/\n/g, " ")).toContain("first half");
    expect(editor.getText()).toContain("second half");
    ui.unmount();
  });

  it("Ctrl+C clears typed text, and needs a second press on an empty prompt to exit", async () => {
    const { stdin, ui, editor } = setup();
    ui.mount();
    const pending = ui.nextInput();
    stdin.type("some text");
    stdin.type("\x03");
    expect(editor.getText()).toBe("");
    stdin.type("\x03");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    stdin.type("\x03");
    await expect(pending).resolves.toEqual({ type: "eof" });
    ui.unmount();
  });

  it("Ctrl+C twice during a turn forces an exit", () => {
    const onInterrupt = vi.fn();
    const onForceExit = vi.fn();
    const { stdin, ui } = setup({ hooks: { onInterrupt, onForceExit } });
    ui.mount();
    ui.setBusy(true);
    stdin.type("\x03");
    stdin.type("\x03");
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onForceExit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it("commits printed text above the prompt without leaving stale boxes behind", () => {
    const { term, stdin, ui } = setup({ rows: 10 });
    ui.mount();
    for (let i = 0; i < 6; i += 1) {
      stdin.type("x");
      ui.print(`output ${i}`);
    }
    const lines = term.lines();
    expect(lines.filter((l) => /^─+$/.test(l))).toHaveLength(2);
    expect(term.transcript().filter((l) => l.startsWith("output"))).toHaveLength(6);
    ui.unmount();
  });

  it("opens the slash menu below the prompt and fills it with Tab", () => {
    const { term, stdin, ui, editor } = setup();
    ui.mount();
    stdin.type("/mo");
    expect(screen(term)).toContain("/model [name]");
    stdin.type("\t");
    expect(editor.getText()).toBe("/model ");
    ui.unmount();
  });

  it("answers a select modal with a hotkey, an arrow+Enter, and Esc", async () => {
    const { term, stdin, ui } = setup({ rows: 20 });
    ui.mount();
    const options = [{ label: "Yes" }, { label: "Always" }, { label: "No" }];
    const first = ui.select({ title: ["Run npm test?"], options, hotkeys: { y: 0, a: 1, n: 2 } });
    expect(screen(term)).toContain("Run npm test?");
    expect(screen(term)).toContain("1. Yes");
    stdin.type("a");
    await expect(first).resolves.toBe(1);

    const second = ui.select({ title: ["Again?"], options });
    stdin.type("\x1b[B");
    stdin.type("\x1b[B");
    stdin.type("\r");
    await expect(second).resolves.toBe(2);

    const third = ui.select({ title: ["Cancel?"], options, cancelIndex: 2 });
    stdin.type("\x1b");
    await expect(third).resolves.toBe(2);
    expect(screen(term)).toContain("❯");
    ui.unmount();
  });

  it("runs modals one at a time", async () => {
    const { stdin, ui } = setup({ rows: 20 });
    ui.mount();
    const options = [{ label: "A" }, { label: "B" }];
    const a = ui.select({ title: ["one"], options });
    const b = ui.select({ title: ["two"], options });
    stdin.type("1");
    await expect(a).resolves.toBe(0);
    await Promise.resolve();
    stdin.type("2");
    await expect(b).resolves.toBe(1);
    ui.unmount();
  });

  it("collects free text in a prompt modal, masking secrets", async () => {
    const { term, stdin, ui } = setup({ rows: 20 });
    ui.mount();
    const pending = ui.prompt({ title: ["API key:"], secret: true });
    stdin.type("sk-secret");
    expect(screen(term)).not.toContain("sk-secret");
    expect(screen(term)).toContain("•••••••••");
    stdin.type("\r");
    await expect(pending).resolves.toBe("sk-secret");
    ui.unmount();
  });

  it("routes console output through the live region while mounted and restores it after", () => {
    const { term, ui } = setup();
    const original = console.log;
    ui.mount();
    console.log("stray", { a: 1 });
    expect(term.transcript().some((l) => l.includes("stray { a: 1 }"))).toBe(true);
    ui.unmount();
    expect(console.log).toBe(original);
  });

  it("redraws on resize without duplicating the box", async () => {
    const { term, stdout, ui } = setup({ cols: 60, rows: 12 });
    ui.mount();
    term.resize(40, 12);
    stdout.emit("resize");
    await new Promise((r) => setTimeout(r, 60));
    expect(term.lines().filter((l) => /^─+$/.test(l))).toHaveLength(2);
    expect(term.lines()[0]).toHaveLength(39);
    ui.unmount();
  });

  it("Vim mode: Esc leaves insert mode (not clear/interrupt), shows the mode, and switches the cursor shape", async () => {
    const writes: string[] = [];
    const onInterrupt = vi.fn();
    const { term, stdin, stdout, ui, editor } = setup({ hooks: { onInterrupt } });
    const original = stdout.write.bind(stdout);
    stdout.write = (data: string) => {
      writes.push(data);
      return original(data);
    };
    editor.setVim(true);
    ui.mount();
    stdin.type("hello");
    expect(screen(term)).toContain("-- INSERT --");
    stdin.type("\x1b");
    await settle();
    expect(editor.vimModeName()).toBe("NORMAL");
    expect(editor.getText()).toBe("hello");
    expect(screen(term)).toContain("-- NORMAL --");
    stdin.type("\x1b"); // another Esc in normal mode must not wipe the prompt
    await settle();
    expect(editor.getText()).toBe("hello");
    // While a task runs, Esc on an empty prompt still interrupts.
    editor.setText("");
    stdin.type("i");
    ui.setBusy(true);
    stdin.type("\x1b");
    await settle();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    ui.unmount();
    const all = writes.join("");
    expect(all).toContain("\u001b[6 q"); // bar in insert mode
    expect(all).toContain("\u001b[2 q"); // block in normal mode
    expect(all.endsWith("\u001b[0 q") || all.includes("\u001b[0 q")).toBe(true);
  });

  it("types multi-line input with Shift+Enter and grows the box", () => {
    const { term, stdin, ui } = setup({ rows: 20 });
    ui.mount();
    stdin.type("line one");
    stdin.type("\x1b[13;2u");
    stdin.type("line two");
    const text = screen(term);
    expect(text).toContain("❯ line one");
    expect(text).toContain("  line two");
    ui.unmount();
  });

  it("shows a pasted block as a placeholder", () => {
    const { term, stdin, ui } = setup({ rows: 20 });
    ui.mount();
    stdin.type(`\x1b[200~${Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n")}\x1b[201~`);
    expect(screen(term)).toContain("[Pasted text #1 +19 lines]");
    ui.unmount();
  });
});
