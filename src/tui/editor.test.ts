import { describe, expect, it } from "vitest";
import { createCompleter, FileIndex } from "./completion.js";
import { LineEditor } from "./editor.js";
import type { KeyEvent } from "./keys.js";

type Mods = { ctrl?: boolean; alt?: boolean; shift?: boolean };
const k = (name: string, mods: Mods = {}): KeyEvent => ({ name, ctrl: false, alt: false, shift: false, ...mods });
const text = (value: string): KeyEvent => ({ name: "text", text: value, ctrl: false, alt: false, shift: false });
const paste = (value: string): KeyEvent => ({ name: "paste", text: value, ctrl: false, alt: false, shift: false });

function editorWith(initial = "", options: ConstructorParameters<typeof LineEditor>[0] = {}): LineEditor {
  const editor = new LineEditor(options);
  if (initial) editor.handle(text(initial));
  return editor;
}

const press = (editor: LineEditor, ...events: KeyEvent[]): void => {
  for (const ev of events) editor.handle(ev);
};

describe("LineEditor: typing and basic editing", () => {
  it("inserts text at the cursor", () => {
    const e = editorWith("helo");
    press(e, k("left"), text("l"));
    expect(e.getText()).toBe("hello");
    expect(e.getCursor()).toBe(4);
  });

  it("backspace and delete respect grapheme clusters", () => {
    const e = editorWith("a👨‍👩‍👧b");
    press(e, k("left"), k("backspace"));
    expect(e.getText()).toBe("ab");
    press(e, k("home"), k("delete"));
    expect(e.getText()).toBe("b");
  });

  it("moves by character, word and line", () => {
    const e = editorWith("alpha beta gamma");
    press(e, k("left", { ctrl: true }));
    expect(e.getCursor()).toBe(11);
    press(e, k("b", { alt: true }));
    expect(e.getCursor()).toBe(6);
    press(e, k("f", { alt: true }));
    expect(e.getCursor()).toBe(10);
    press(e, k("home"));
    expect(e.getCursor()).toBe(0);
    press(e, k("end"));
    expect(e.getCursor()).toBe(16);
  });

  it("Ctrl+A / Ctrl+E go to the start and end of the current line", () => {
    const e = editorWith("one");
    press(e, k("return", { shift: true }), text("two"), k("a", { ctrl: true }));
    expect(e.getCursor()).toBe(4);
    press(e, k("e", { ctrl: true }));
    expect(e.getCursor()).toBe(7);
  });
});

describe("LineEditor: kill ring, words, transpose", () => {
  it("Ctrl+W deletes back to whitespace; Alt+Backspace deletes a word", () => {
    const e = editorWith("run src/tui/foo.ts");
    press(e, k("w", { ctrl: true }));
    expect(e.getText()).toBe("run ");
    const f = editorWith("foo.bar baz");
    press(f, k("backspace", { alt: true }));
    expect(f.getText()).toBe("foo.bar ");
  });

  it("Ctrl+K and Ctrl+U kill to line end / start, Ctrl+Y yanks", () => {
    const e = editorWith("hello world");
    press(e, k("b", { alt: true }), k("k", { ctrl: true }));
    expect(e.getText()).toBe("hello ");
    press(e, k("u", { ctrl: true }));
    expect(e.getText()).toBe("");
    press(e, k("y", { ctrl: true }));
    expect(e.getText()).toBe("hello world".slice(0, 6) + "world");
  });

  it("successive kills accumulate into one yank", () => {
    const e = editorWith("a b c");
    press(e, k("w", { ctrl: true }), k("w", { ctrl: true }));
    expect(e.getText()).toBe("a ");
    press(e, k("y", { ctrl: true }));
    expect(e.getText()).toBe("a b c");
  });

  it("Ctrl+T swaps the characters around the cursor", () => {
    const e = editorWith("abc");
    press(e, k("t", { ctrl: true }));
    expect(e.getText()).toBe("acb");
  });

  it("Alt+D deletes the next word", () => {
    const e = editorWith("one two three");
    press(e, k("home"), k("d", { alt: true }));
    expect(e.getText()).toBe(" two three");
  });
});

describe("LineEditor: multi-line", () => {
  it("Shift+Enter, Alt+Enter and Ctrl+J insert newlines", () => {
    const e = editorWith("a");
    press(e, k("return", { shift: true }), text("b"), k("return", { alt: true }), text("c"), k("j", { ctrl: true }), text("d"));
    expect(e.getText()).toBe("a\nb\nc\nd");
  });

  it("a trailing backslash plus Enter continues the line", () => {
    const e = editorWith("line one\\");
    expect(e.handle(k("return"))).toEqual({ type: "handled" });
    expect(e.getText()).toBe("line one\n");
  });

  it("Up/Down move between visual rows before touching history", () => {
    const e = editorWith("", { history: ["old prompt"] });
    press(e, text("ab"), k("return", { shift: true }), text("cd"));
    press(e, k("up"));
    expect(e.getCursor()).toBe(2);
    expect(e.getText()).toBe("ab\ncd");
    press(e, k("down"));
    expect(e.getCursor()).toBe(5);
  });

  it("remembers the goal column across short rows", () => {
    const e = editorWith("abcdef");
    press(e, k("return", { shift: true }), text("x"), k("return", { shift: true }), text("ghijkl"));
    press(e, k("up"), k("up"));
    expect(e.getCursor()).toBe(6); // the short middle row clamped the cursor, but the goal column (6) is remembered
    press(e, k("down"));
    expect(e.getCursor()).toBe(8); // clamped to the end of "x"
    press(e, k("down"));
    expect(e.getCursor()).toBe(15); // back at column 6 of the last row
  });

  it("wraps long lines and moves vertically through wrapped rows", () => {
    const e = new LineEditor();
    e.setWidth(10);
    press(e, text("aaaa bbbb cccc dddd"));
    const view = e.view(10, 10);
    expect(view.rows.length).toBeGreaterThan(1);
    const before = e.getCursor();
    press(e, k("up"));
    expect(e.getCursor()).toBeLessThan(before);
  });
});

describe("LineEditor: submit", () => {
  it("submits trimmed text and clears", () => {
    const e = editorWith("hello  ");
    const result = e.handle(k("return"));
    expect(result).toEqual({ type: "submit", text: "hello", display: "hello" });
    expect(e.getText()).toBe("");
  });

  it("ignores Enter on blank input", () => {
    const e = editorWith("   ");
    expect(e.handle(k("return"))).toEqual({ type: "handled" });
  });

  it("returns unhandled for keys the host owns", () => {
    const e = editorWith("x");
    expect(e.handle(k("c", { ctrl: true }))).toEqual({ type: "unhandled" });
    expect(e.handle(k("escape"))).toEqual({ type: "unhandled" });
    expect(e.handle(k("tab", { shift: true }))).toEqual({ type: "unhandled" });
    expect(e.handle(k("l", { ctrl: true }))).toEqual({ type: "unhandled" });
  });

  it("Ctrl+D deletes forward, but is unhandled (exit request) on an empty line", () => {
    const e = editorWith("ab");
    press(e, k("home"), k("d", { ctrl: true }));
    expect(e.getText()).toBe("b");
    press(e, k("d", { ctrl: true }));
    expect(e.handle(k("d", { ctrl: true }))).toEqual({ type: "unhandled" });
  });
});

describe("LineEditor: history", () => {
  it("Up/Down walk through history and restore the draft", () => {
    const e = new LineEditor({ history: ["first", "second"] });
    press(e, text("draft"), k("up"));
    expect(e.getText()).toBe("second");
    press(e, k("up"));
    expect(e.getText()).toBe("first");
    press(e, k("up"));
    expect(e.getText()).toBe("first");
    press(e, k("down"), k("down"));
    expect(e.getText()).toBe("draft");
  });

  it("remembers submitted prompts", () => {
    const e = new LineEditor();
    press(e, text("one"));
    e.handle(k("return"));
    press(e, k("up"));
    expect(e.getText()).toBe("one");
  });

  it("Ctrl+R searches backwards, Ctrl+R again finds older matches, Enter accepts", () => {
    const e = new LineEditor({ history: ["git status", "npm test", "git commit -m x"] });
    press(e, k("r", { ctrl: true }), text("git"));
    expect(e.getText()).toBe("git commit -m x");
    expect(e.view(40, 5).search).toEqual({ query: "git", failed: false });
    press(e, k("r", { ctrl: true }));
    expect(e.getText()).toBe("git status");
    press(e, k("return"));
    expect(e.searching()).toBe(false);
    expect(e.getText()).toBe("git status");
  });

  it("Escape cancels a search and restores the draft", () => {
    const e = new LineEditor({ history: ["alpha"] });
    press(e, text("draft"), k("r", { ctrl: true }), text("alp"), k("escape"));
    expect(e.getText()).toBe("draft");
  });

  it("flags a search with no match", () => {
    const e = new LineEditor({ history: ["alpha"] });
    press(e, k("r", { ctrl: true }), text("zzz"));
    expect(e.view(40, 5).search).toEqual({ query: "zzz", failed: true });
  });
});

describe("LineEditor: undo", () => {
  it("undoes typing a word at a time", () => {
    const e = new LineEditor();
    for (const ch of "hello world") press(e, text(ch));
    press(e, k("_", { ctrl: true }));
    expect(e.getText()).toBe("hello ");
    press(e, k("_", { ctrl: true }));
    expect(e.getText()).toBe("");
  });

  it("undoes a kill and a clear", () => {
    const e = editorWith("keep me");
    e.clear();
    expect(e.getText()).toBe("");
    press(e, k("_", { ctrl: true }));
    expect(e.getText()).toBe("keep me");
  });
});

describe("LineEditor: paste", () => {
  it("inserts a short paste verbatim", () => {
    const e = new LineEditor();
    press(e, paste("a\nb"));
    expect(e.getText()).toBe("a\nb");
  });

  it("collapses a long paste into an atomic placeholder and expands it on submit", () => {
    const e = new LineEditor();
    const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    press(e, text("see: "), paste(big));
    expect(e.getText()).toBe("see: [Pasted text #1 +11 lines]");
    const result = e.handle(k("return"));
    expect(result).toEqual({ type: "submit", text: `see: ${big}`, display: "see: [Pasted text #1 +11 lines]" });
  });

  it("deletes the whole placeholder with one backspace and moves over it as one unit", () => {
    const e = new LineEditor();
    press(e, text("x"), paste("l\n".repeat(10)), text("y"));
    press(e, k("left"), k("left"));
    expect(e.getText().slice(0, e.getCursor())).toBe("x");
    press(e, k("right"), k("backspace"));
    expect(e.getText()).toBe("xy");
  });

  it("lets the host rewrite a paste (a dropped file path becomes a mention)", () => {
    const e = new LineEditor({ transformPaste: (t) => (t === "/p/a.ts" ? "@a.ts " : undefined) });
    press(e, text("see "), paste("/p/a.ts"));
    expect(e.getText()).toBe("see @a.ts ");
    press(e, paste("other"));
    expect(e.getText()).toBe("see @a.ts other");
  });

  it("collapses a very long single line by character count", () => {
    const e = new LineEditor();
    press(e, paste("x".repeat(2500)));
    expect(e.getText()).toBe("[Pasted text #1 2,500 chars]");
  });

  it("normalizes CRLF and strips control characters", () => {
    const e = new LineEditor();
    press(e, paste("a\r\nb\u0007"));
    expect(e.getText()).toBe("a\nb");
  });
});

describe("LineEditor: completion menu", () => {
  const completer = createCompleter({
    commands: () => [
      { command: "/help", description: "Show help" },
      { command: "/model", description: "Switch model", args: "[name]", values: () => ["glm-5.2", "glm-4.7"] },
      { command: "/mode", description: "Permission mode", args: "[mode]" },
    ],
  });

  it("opens for a slash prefix, navigates, and Tab accepts", () => {
    const e = new LineEditor({ completer });
    press(e, text("/mo"));
    expect(e.menuView()?.items.map((i) => i.insert)).toEqual(["/model", "/mode"]);
    press(e, k("down"), k("tab"));
    expect(e.getText()).toBe("/mode ");
    expect(e.menuView()).toBeUndefined();
  });

  it("Enter on a no-argument command accepts and submits in one go", () => {
    const e = new LineEditor({ completer });
    press(e, text("/he"));
    expect(e.handle(k("return"))).toEqual({ type: "submit", text: "/help", display: "/help" });
  });

  it("Enter on a command that takes arguments only completes it", () => {
    const e = new LineEditor({ completer });
    press(e, text("/mod"));
    expect(e.handle(k("return"))).toEqual({ type: "handled" });
    expect(e.getText()).toBe("/model ");
  });

  it("Enter on a fully typed command runs it", () => {
    const e = new LineEditor({ completer });
    press(e, text("/help"));
    expect(e.handle(k("return"))).toMatchObject({ type: "submit", text: "/help" });
  });

  it("offers argument values after the command name", () => {
    const e = new LineEditor({ completer });
    press(e, text("/model gl"));
    expect(e.menuView()?.items.map((i) => i.insert)).toEqual(["glm-5.2", "glm-4.7"]);
    press(e, k("tab"));
    expect(e.getText()).toBe("/model glm-5.2");
  });

  it("Escape dismisses the menu until the text changes", () => {
    const e = new LineEditor({ completer });
    press(e, text("/h"));
    expect(e.menuView()).toBeDefined();
    expect(e.handle(k("escape"))).toEqual({ type: "handled" });
    expect(e.menuView()).toBeUndefined();
    press(e, text("e"));
    expect(e.menuView()).toBeDefined();
  });

  it("does not pop the menu while browsing history", () => {
    const e = new LineEditor({ completer, history: ["/help"] });
    press(e, k("up"));
    expect(e.getText()).toBe("/help");
    expect(e.menuView()).toBeUndefined();
  });

  it("completes @file mentions from the file index", () => {
    const index = new FileIndex("/nowhere");
    index.setFiles(["src/index.ts", "src/tui/editor.ts", "README.md"]);
    const e = new LineEditor({ completer: createCompleter({ commands: () => [], files: index }) });
    press(e, text("look at @edi"));
    expect(e.menuView()?.items[0].insert).toBe("@src/tui/editor.ts");
    press(e, k("tab"));
    expect(e.getText()).toBe("look at @src/tui/editor.ts ");
  });

  it("browses a directory when the mention ends with a slash", () => {
    const index = new FileIndex("/nowhere");
    index.setFiles(["src/a.ts", "src/b.ts", "src/deep/c.ts", "other.ts"]);
    const e = new LineEditor({ completer: createCompleter({ commands: () => [], files: index }) });
    press(e, text("@src/"));
    expect(e.menuView()?.items.map((i) => i.label)).toEqual(["src/deep/", "src/a.ts", "src/b.ts"]);
  });
});
