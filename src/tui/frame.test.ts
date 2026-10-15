import { describe, expect, it } from "vitest";
import { createCompleter } from "./completion.js";
import { LineEditor } from "./editor.js";
import { buildFrame, shortenPath, type FrameModel } from "./frame.js";
import type { KeyEvent } from "./keys.js";
import { plainStyle } from "./style.js";
import { visibleWidth } from "./width.js";

const style = plainStyle();
const text = (value: string): KeyEvent => ({ name: "text", text: value, ctrl: false, alt: false, shift: false });
const key = (name: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({ name, ctrl: false, alt: false, shift: false, ...mods });

function model(overrides: Partial<FrameModel> = {}): FrameModel {
  return {
    cols: 80,
    rows: 30,
    queue: [],
    editor: new LineEditor(),
    placeholder: "Ask…",
    status: { cwd: "/work/proj", branch: "main", mode: "ask", model: "glm-5.2", contextPercent: 0, extra: [] },
    ...overrides,
  };
}

describe("buildFrame: prompt box", () => {
  it("draws rules, the prompt with a placeholder, and the status line", () => {
    const frame = buildFrame(model(), style);
    expect(frame.lines).toHaveLength(4);
    expect(frame.lines[0]).toMatch(/^─+$/);
    expect(frame.lines[1]).toBe("❯ Ask…");
    expect(frame.lines[2]).toMatch(/^─+$/);
    expect(frame.lines[3]).toContain("ask before changes");
    expect(frame.lines[3]).toContain("/work/proj (main)");
    expect(frame.cursor).toEqual({ row: 1, col: 2 });
  });

  it("puts the cursor after the typed text, across wrapped and multi-line input", () => {
    const editor = new LineEditor();
    editor.handle(text("hello"));
    expect(buildFrame(model({ editor }), style).cursor).toEqual({ row: 1, col: 7 });
    editor.handle(key("return", { shift: true }));
    editor.handle(text("ab"));
    const frame = buildFrame(model({ editor }), style);
    expect(frame.lines.slice(1, 3)).toEqual(["❯ hello", "  ab"]);
    expect(frame.cursor).toEqual({ row: 2, col: 4 });
  });

  it("never produces a row wider than the terminal", () => {
    const editor = new LineEditor();
    editor.handle(text("x".repeat(300)));
    for (const cols of [20, 40, 80]) {
      const frame = buildFrame(model({ cols, editor }), style);
      for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
    }
  });

  it("scrolls a tall input and says how many rows are hidden", () => {
    const editor = new LineEditor();
    for (let i = 0; i < 30; i += 1) {
      editor.handle(text(`line ${i}`));
      editor.handle(key("return", { shift: true }));
    }
    const frame = buildFrame(model({ editor, rows: 24 }), style);
    expect(frame.lines.length).toBeLessThanOrEqual(23);
    expect(frame.lines[0]).toContain("more");
    expect(frame.lines[0]).toContain("↑");
  });

  it("labels the top rule during reverse search", () => {
    const editor = new LineEditor({ history: ["git status"] });
    editor.handle(key("r", { ctrl: true }));
    editor.handle(text("git"));
    expect(buildFrame(model({ editor }), style).lines[0]).toContain('search: "git"');
  });

  it("marks shell mode with a ! prompt", () => {
    const editor = new LineEditor();
    editor.handle(text("!ls"));
    expect(buildFrame(model({ editor }), style).lines[1]).toBe("! !ls");
  });
});

describe("buildFrame: activity, queue and detail", () => {
  it("shows the activity line, a dim detail row and queued messages above the prompt", () => {
    const frame = buildFrame(
      model({
        activity: { label: "Cooking…", meta: "12s · esc to interrupt", mode: "spin", frame: 0 },
        detail: "compiling module b",
        queue: ["add tests", "and docs"],
      }),
      style,
    );
    expect(frame.lines[0]).toBe("");
    expect(frame.lines[1]).toBe("⠋ Cooking…  12s · esc to interrupt");
    expect(frame.lines[2]).toBe("  ▎ compiling module b");
    expect(frame.lines[3]).toBe("  ⏎ add tests");
    expect(frame.lines[4]).toBe("  ⏎ and docs");
    expect(frame.cursor?.row).toBe(6);
  });

  it("collapses a long queue", () => {
    const frame = buildFrame(model({ queue: ["a", "b", "c", "d", "e"] }), style);
    expect(frame.lines.filter((l) => l.includes("⏎"))).toHaveLength(3);
    expect(frame.lines.some((l) => l.includes("+2 more queued"))).toBe(true);
  });

  it("shows a streaming tail above the activity line", () => {
    const frame = buildFrame(model({ tail: "  partial line", activity: { label: "Cooking…", meta: "", mode: "spin", frame: 1 } }), style);
    expect(frame.lines[0]).toBe("  partial line");
  });

  it("drops the optional rows on very short terminals", () => {
    const frame = buildFrame(model({ rows: 8, queue: ["x"], tail: "t", activity: { label: "A", meta: "", mode: "spin", frame: 0 } }), style);
    expect(frame.lines.some((l) => l.includes("⏎"))).toBe(false);
    expect(frame.lines).not.toContain("t");
  });
});

describe("buildFrame: status line", () => {
  it("adapts to narrow widths: first the directory, then the model, go away", () => {
    const wide = buildFrame(model({ cols: 100 }), style).lines.at(-1) as string;
    expect(wide).toContain("/work/proj (main)");
    expect(wide).toContain("glm-5.2");
    const narrow = buildFrame(model({ cols: 36 }), style).lines.at(-1) as string;
    expect(narrow).not.toContain("/work/proj");
    expect(narrow).toContain("glm-5.2");
    const tiny = buildFrame(model({ cols: 24 }), style).lines.at(-1) as string;
    expect(visibleWidth(tiny)).toBeLessThanOrEqual(24);
  });

  it("colors nothing in plain mode but names the mode and context", () => {
    const frame = buildFrame(model({ status: { cwd: "/p", mode: "plan", model: "m", contextPercent: 73, extra: ["⌬ universe u1"] } }), style);
    const status = frame.lines.at(-1) as string;
    expect(status).toContain("plan · read-only");
    expect(status).toContain("⌬ universe u1");
    expect(status).toContain("73% ctx");
  });

  it("replaces the left side with an ephemeral hint", () => {
    const status = buildFrame(model({ hint: "Press Ctrl-C again to exit" }), style).lines.at(-1) as string;
    expect(status.startsWith("Press Ctrl-C again to exit")).toBe(true);
  });

  it("shortens paths relative to home and from the left", () => {
    expect(shortenPath("/home/u/code/app", "/home/u", 40)).toBe("~/code/app");
    expect(shortenPath("/very/long/path/to/some/deep/project", "/home/u", 20)).toMatch(/^…\//);
    expect(shortenPath("/very/long/path/to/some/deep/project", "/home/u", 20).length).toBeLessThanOrEqual(20);
  });
});

describe("buildFrame: completion menu", () => {
  it("lists matches with the selection marked and shows the scroll position", () => {
    const commands = Array.from({ length: 12 }, (_, i) => ({ command: `/cmd${String(i).padStart(2, "0")}`, description: `does ${i}` }));
    const editor = new LineEditor({ completer: createCompleter({ commands: () => commands }) });
    editor.handle(text("/c"));
    editor.handle(key("down"));
    const lines = buildFrame(model({ editor, rows: 40 }), style).lines;
    const menu = lines.filter((l) => /\/cmd\d\d/.test(l));
    expect(menu).toHaveLength(8);
    expect(menu[1].startsWith("❯ /cmd01")).toBe(true);
    expect(menu[0].startsWith("  /cmd00")).toBe(true);
    expect(lines.some((l) => l.includes("2/12"))).toBe(true);
  });

  it("shows fewer rows on short terminals", () => {
    const commands = Array.from({ length: 12 }, (_, i) => ({ command: `/cmd${i}`, description: "d" }));
    const editor = new LineEditor({ completer: createCompleter({ commands: () => commands }) });
    editor.handle(text("/c"));
    const menu = buildFrame(model({ editor, rows: 16 }), style).lines.filter((l) => /\/cmd\d/.test(l));
    expect(menu).toHaveLength(4);
  });
});

describe("buildFrame: modals", () => {
  it("lays out a select with numbered options, a pointer, and a footer", () => {
    const frame = buildFrame(
      model({
        modal: { kind: "select", title: ["⚠ Run this command?", "  $ ls"], options: [{ label: "Yes" }, { label: "No" }], selected: 1, footer: "enter to select" },
      }),
      style,
    );
    expect(frame.lines[0]).toMatch(/^─+$/);
    expect(frame.lines.slice(1, 5)).toEqual(["⚠ Run this command?", "  $ ls", "  1. Yes", "❯ 2. No"]);
    expect(frame.lines[5]).toBe("  enter to select");
    expect(frame.cursor).toBeUndefined();
  });

  it("aligns option hints in a column", () => {
    const frame = buildFrame(
      model({ modal: { kind: "select", title: [], options: [{ label: "a", hint: "first" }, { label: "longer", hint: "second" }], selected: 0 } }),
      style,
    );
    const rows = frame.lines.filter((l) => /\d\. /.test(l));
    expect(rows[0].indexOf("first")).toBe(rows[1].indexOf("second"));
  });

  it("clips a tall title to the space available", () => {
    const title = Array.from({ length: 40 }, (_, i) => `row ${i}`);
    const frame = buildFrame(model({ rows: 14, modal: { kind: "select", title, options: [{ label: "Yes" }, { label: "No" }], selected: 0 } }), style);
    expect(frame.lines.length).toBeLessThanOrEqual(13);
    expect(frame.lines.some((l) => l.includes("more lines"))).toBe(true);
  });

  it("draws an input modal with the cursor, masking secrets", () => {
    const editor = new LineEditor();
    editor.handle(text("hunter2"));
    const plain = buildFrame(model({ modal: { kind: "input", title: ["Name?"], editor, secret: false } }), style);
    expect(plain.lines.some((l) => l === "❯ hunter2")).toBe(true);
    const secret = buildFrame(model({ modal: { kind: "input", title: ["Key?"], editor, secret: true } }), style);
    expect(secret.lines.some((l) => l === "❯ •••••••")).toBe(true);
    expect(secret.cursor).toEqual({ row: 2, col: 9 });
  });

  it("draws nothing at all in minimal mode without a modal", () => {
    expect(buildFrame(model({ minimal: true }), style).lines).toEqual([]);
  });
});
