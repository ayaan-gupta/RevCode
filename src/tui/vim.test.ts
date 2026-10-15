import { describe, expect, it } from "vitest";
import { LineEditor } from "./editor.js";
import type { KeyEvent } from "./keys.js";

const ev = (name: string, extra: Partial<KeyEvent> = {}): KeyEvent => ({ name, ctrl: false, alt: false, shift: false, ...extra });

/** Type a string of keystrokes; "\x1b" is Escape. */
function keys(editor: LineEditor, input: string): void {
  for (const ch of input) {
    if (ch === "\x1b") editor.handle(ev("escape"));
    else if (ch === "\n") editor.handle(ev("return", { shift: true }));
    else editor.handle(ev("text", { text: ch }));
  }
}

function vim(initial = "", history: string[] = []): LineEditor {
  const editor = new LineEditor({ history });
  editor.setVim(true);
  keys(editor, initial);
  keys(editor, "\x1b");
  return editor;
}

describe("Vim mode: modes", () => {
  it("starts in insert mode, Esc enters normal mode and steps back onto the last character", () => {
    const e = new LineEditor();
    e.setVim(true);
    expect(e.vimModeName()).toBe("INSERT");
    keys(e, "hello");
    expect(e.consumesEscape()).toBe(true);
    keys(e, "\x1b");
    expect(e.vimModeName()).toBe("NORMAL");
    expect(e.getCursor()).toBe(4);
    expect(e.consumesEscape()).toBe(false);
    expect(e.getText()).toBe("hello");
  });

  it("does nothing special when Vim mode is off", () => {
    const e = new LineEditor();
    expect(e.vimModeName()).toBeUndefined();
    keys(e, "hi\x1b");
    expect(e.handle(ev("escape"))).toEqual({ type: "unhandled" });
    expect(e.getText()).toBe("hi");
  });

  it("i a I A o O enter insert mode in the right place", () => {
    let e = vim("hello");
    keys(e, "0iX\x1b");
    expect(e.getText()).toBe("Xhello");
    e = vim("hello");
    keys(e, "0aX\x1b");
    expect(e.getText()).toBe("hXello");
    e = vim("  hello");
    keys(e, "IX\x1b");
    expect(e.getText()).toBe("  Xhello");
    e = vim("hello");
    keys(e, "AX\x1b");
    expect(e.getText()).toBe("helloX");
    e = vim("one");
    keys(e, "otwo\x1b");
    expect(e.getText()).toBe("one\ntwo");
    e = vim("two");
    keys(e, "Oone\x1b");
    expect(e.getText()).toBe("one\ntwo");
  });

  it("Enter in normal mode still submits", () => {
    const e = vim("send me");
    expect(e.handle(ev("return"))).toMatchObject({ type: "submit", text: "send me" });
  });
});

describe("Vim mode: motions", () => {
  it("h l 0 ^ $ move within the line and stay on characters", () => {
    const e = vim("  hello world");
    keys(e, "0");
    expect(e.getCursor()).toBe(0);
    keys(e, "^");
    expect(e.getCursor()).toBe(2);
    keys(e, "$");
    expect(e.getCursor()).toBe(12);
    keys(e, "l");
    expect(e.getCursor()).toBe(12);
    keys(e, "3h");
    expect(e.getCursor()).toBe(9);
  });

  it("w b e honour counts", () => {
    const e = vim("one two three four");
    keys(e, "0w");
    expect(e.getCursor()).toBe(4);
    keys(e, "2w");
    expect(e.getCursor()).toBe(14);
    keys(e, "b");
    expect(e.getCursor()).toBe(8);
    keys(e, "0e");
    expect(e.getCursor()).toBe(2);
  });

  it("f t ; , find characters on the line", () => {
    const e = vim("a-b-c-d");
    keys(e, "0f-");
    expect(e.getCursor()).toBe(1);
    keys(e, ";");
    expect(e.getCursor()).toBe(3);
    keys(e, ",");
    expect(e.getCursor()).toBe(1);
    keys(e, "0t-");
    expect(e.getCursor()).toBe(0);
    keys(e, "$F-");
    expect(e.getCursor()).toBe(5);
  });

  it("gg and G jump to the start and the last line", () => {
    const e = vim("one\ntwo\nthree");
    keys(e, "gg");
    expect(e.getCursor()).toBe(0);
    keys(e, "G");
    expect(e.getCursor()).toBe(8);
  });

  it("j and k move between lines, falling back to history at the edges", () => {
    const e = vim("one\ntwo", ["older prompt"]);
    keys(e, "k");
    expect(e.getCursor()).toBeLessThan(4);
    keys(e, "k");
    expect(e.getText()).toBe("older prompt");
  });
});

describe("Vim mode: editing", () => {
  it("x X delete characters (with counts) and u undoes", () => {
    const e = vim("hello");
    keys(e, "0x");
    expect(e.getText()).toBe("ello");
    keys(e, "2x");
    expect(e.getText()).toBe("lo");
    keys(e, "$X");
    expect(e.getText()).toBe("o");
    keys(e, "u");
    expect(e.getText()).toBe("lo");
  });

  it("dw, d$, d0 and dd delete and fill the register", () => {
    let e = vim("one two three");
    keys(e, "0dw");
    expect(e.getText()).toBe("two three");
    keys(e, "wd$");
    expect(e.getText()).toBe("two ");
    e = vim("one two");
    keys(e, "$d0");
    expect(e.getText()).toBe("o");
    e = vim("a\nb\nc");
    keys(e, "ggdd");
    expect(e.getText()).toBe("b\nc");
    keys(e, "Gdd");
    expect(e.getText()).toBe("b");
  });

  it("d with counts and de/db", () => {
    let e = vim("one two three four");
    keys(e, "0d2w");
    expect(e.getText()).toBe("three four");
    e = vim("one two three");
    keys(e, "0wde");
    expect(e.getText()).toBe("one  three");
    e = vim("one two three");
    keys(e, "$db");
    expect(e.getText()).toBe("one two e");
  });

  it("cw, cc, C and s start inserting", () => {
    let e = vim("one two");
    keys(e, "0cwONE\x1b");
    expect(e.getText()).toBe("ONE two");
    e = vim("line one\nline two");
    keys(e, "Gccnew\x1b");
    expect(e.getText()).toBe("line one\nnew");
    e = vim("hello world");
    keys(e, "0wCthere\x1b");
    expect(e.getText()).toBe("hello there");
    e = vim("abc");
    keys(e, "0sX\x1b");
    expect(e.getText()).toBe("Xbc");
  });

  it("yy / yw and p / P paste lines and words", () => {
    let e = vim("one\ntwo");
    keys(e, "ggyyp");
    expect(e.getText()).toBe("one\none\ntwo");
    e = vim("one\ntwo");
    keys(e, "GyyP");
    expect(e.getText()).toBe("one\ntwo\ntwo");
    e = vim("foo bar");
    keys(e, "0ywA \x1b");
    keys(e, "p");
    expect(e.getText()).toBe("foo bar foo ");
  });

  it("dd then p moves a line", () => {
    const e = vim("a\nb\nc");
    keys(e, "ggddp");
    expect(e.getText()).toBe("b\na\nc");
  });

  it("r replaces characters, ~ toggles case, J joins lines", () => {
    let e = vim("hello");
    keys(e, "0rj");
    expect(e.getText()).toBe("jello");
    keys(e, "$3~");
    expect(e.getText()).toBe("jellO");
    e = vim("one\n  two");
    keys(e, "ggJ");
    expect(e.getText()).toBe("one two");
  });

  it("a command followed by Escape cancels a pending operator", () => {
    const e = vim("keep me");
    keys(e, "0d\x1bw");
    expect(e.getText()).toBe("keep me");
    expect(e.getCursor()).toBe(5);
  });

  it("undoes a whole insert session at once and never inserts normal-mode keys as text", () => {
    const e = vim("base");
    keys(e, "Aabc\x1bzzz");
    expect(e.getText()).toBe("baseabc");
    keys(e, "u");
    expect(e.getText()).toBe("base");
  });
});

describe("Vim mode: keystrokes arriving in one chunk", () => {
  it("treats text after an insert command as typed text, not more commands", () => {
    const e = vim("fix the bug");
    e.handle(ev("text", { text: "0wcwrepair" }));
    expect(e.getText()).toBe("fix repair bug");
    expect(e.vimModeName()).toBe("INSERT");
    e.handle(ev("escape"));
    e.handle(ev("text", { text: "0Aend" }));
    expect(e.getText()).toBe("fix repair bugend");
  });

  it("keeps interpreting commands after a non-inserting command in the same chunk", () => {
    const e = vim("abcdef");
    e.handle(ev("text", { text: "0xxx" }));
    expect(e.getText()).toBe("def");
  });
});
