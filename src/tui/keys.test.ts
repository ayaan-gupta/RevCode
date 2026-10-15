import { describe, expect, it } from "vitest";
import { KeyParser, type KeyEvent } from "./keys.js";

function parse(...chunks: string[]): KeyEvent[] {
  const parser = new KeyParser();
  return chunks.flatMap((chunk) => parser.feed(chunk));
}

const names = (events: KeyEvent[]): string[] => events.map((e) => e.name);

describe("KeyParser: text and control keys", () => {
  it("emits a run of typed text as one event", () => {
    expect(parse("hello")).toMatchObject([{ name: "text", text: "hello" }]);
  });

  it("keeps non-ASCII text together", () => {
    expect(parse("héllo 日本 🚀")).toMatchObject([{ name: "text", text: "héllo 日本 🚀" }]);
  });

  it("parses Enter, Tab, Backspace, Escape", () => {
    expect(names(parse("\r"))).toEqual(["return"]);
    expect(names(parse("\t"))).toEqual(["tab"]);
    expect(names(parse("\x7f"))).toEqual(["backspace"]);
    const parser = new KeyParser();
    expect(parser.feed("\x1b")).toEqual([]); // might be the start of a sequence split across reads
    expect(parser.hasPending).toBe(true);
    expect(names(parser.flush())).toEqual(["escape"]);
  });

  it("parses ctrl+letter chords", () => {
    expect(parse("\x03")).toMatchObject([{ name: "c", ctrl: true }]);
    expect(parse("\x01")).toMatchObject([{ name: "a", ctrl: true }]);
    expect(parse("\x1a")).toMatchObject([{ name: "z", ctrl: true }]);
    expect(parse("\x1f")).toMatchObject([{ name: "_", ctrl: true }]);
  });

  it("treats a bare newline as Ctrl+J (insert newline), not Enter", () => {
    expect(parse("\n")).toMatchObject([{ name: "j", ctrl: true }]);
  });

  it("separates text typed before a control key", () => {
    expect(parse("ls\r")).toMatchObject([{ name: "text", text: "ls" }, { name: "return" }]);
  });
});

describe("KeyParser: escape sequences", () => {
  it("parses arrows, home/end, delete, page keys", () => {
    expect(names(parse("\x1b[A\x1b[B\x1b[C\x1b[D"))).toEqual(["up", "down", "right", "left"]);
    expect(names(parse("\x1b[H\x1b[F"))).toEqual(["home", "end"]);
    expect(names(parse("\x1b[1~\x1b[4~"))).toEqual(["home", "end"]);
    expect(names(parse("\x1b[3~"))).toEqual(["delete"]);
    expect(names(parse("\x1b[5~\x1b[6~"))).toEqual(["pageup", "pagedown"]);
  });

  it("parses application-mode (SS3) arrows", () => {
    expect(names(parse("\x1bOA\x1bOD"))).toEqual(["up", "left"]);
  });

  it("decodes modifiers on arrows", () => {
    expect(parse("\x1b[1;5D")).toMatchObject([{ name: "left", ctrl: true }]);
    expect(parse("\x1b[1;3C")).toMatchObject([{ name: "right", alt: true }]);
    expect(parse("\x1b[1;2A")).toMatchObject([{ name: "up", shift: true }]);
    expect(parse("\x1b[3;5~")).toMatchObject([{ name: "delete", ctrl: true }]);
  });

  it("parses Shift+Tab", () => {
    expect(parse("\x1b[Z")).toMatchObject([{ name: "tab", shift: true }]);
  });

  it("parses Alt+key", () => {
    expect(parse("\x1bb")).toMatchObject([{ name: "b", alt: true }]);
    expect(parse("\x1bf")).toMatchObject([{ name: "f", alt: true }]);
    expect(parse("\x1b\r")).toMatchObject([{ name: "return", alt: true }]);
    expect(parse("\x1b\x7f")).toMatchObject([{ name: "backspace", alt: true }]);
  });

  it("parses kitty protocol keys (Shift+Enter, Ctrl+letters, Escape)", () => {
    expect(parse("\x1b[13;2u")).toMatchObject([{ name: "return", shift: true }]);
    expect(parse("\x1b[13;3u")).toMatchObject([{ name: "return", alt: true }]);
    expect(parse("\x1b[99;5u")).toMatchObject([{ name: "c", ctrl: true }]);
    expect(parse("\x1b[27u")).toMatchObject([{ name: "escape" }]);
    expect(parse("\x1b[127u")).toMatchObject([{ name: "backspace" }]);
  });

  it("parses xterm modifyOtherKeys Shift+Enter", () => {
    expect(parse("\x1b[27;2;13~")).toMatchObject([{ name: "return", shift: true }]);
  });

  it("reports focus changes", () => {
    expect(names(parse("\x1b[I\x1b[O"))).toEqual(["focus-in", "focus-out"]);
  });

  it("swallows terminal replies instead of typing them", () => {
    expect(names(parse("\x1b[?0u"))).toEqual(["response"]);
    expect(names(parse("\x1b]11;rgb:0000/0000/0000\x07"))).toEqual(["response"]);
    expect(names(parse("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"))).toEqual(["response"]);
    expect(names(parse("\x1b[<0;10;5M"))).toEqual(["response"]);
  });
});

describe("KeyParser: chunking and paste", () => {
  it("reassembles a CSI sequence split across chunks, including a lone ESC read on its own", () => {
    expect(names(parse("\x1b", "[A"))).toEqual(["up"]);
    expect(names(parse("\x1b[1", ";5D"))).toEqual(["left"]);
    expect(names(parse("\x1b", "b"))).toEqual(["b"]);
  });

  it("collects bracketed paste, including newlines", () => {
    expect(parse("\x1b[200~line one\nline two\x1b[201~")).toMatchObject([{ name: "paste", text: "line one\nline two" }]);
  });

  it("collects a bracketed paste split over several chunks", () => {
    const events = parse("\x1b[200~abc", "def\nghi\x1b[20", "1~x");
    expect(events).toMatchObject([{ name: "paste", text: "abcdef\nghi" }, { name: "text", text: "x" }]);
  });

  it("does not let escape codes inside a paste act as keys", () => {
    expect(parse("\x1b[200~\x1b[A\x1b[201~")).toMatchObject([{ name: "paste", text: "\x1b[A" }]);
  });

  it("treats multi-line text without bracketed paste as a paste, not as Enter keypresses", () => {
    const events = parse("first\rsecond\rthird");
    expect(events).toMatchObject([{ name: "paste", text: "first\nsecond\nthird" }]);
  });

  it("keeps a trailing Enter after an un-bracketed paste as a real Enter", () => {
    const events = parse("first\rsecond\r");
    expect(events).toMatchObject([{ name: "paste", text: "first\nsecond" }, { name: "return" }]);
  });

  it("a flush in the middle of a paste does not abandon it", () => {
    const parser = new KeyParser();
    parser.feed("\x1b[200~some text\x1b");
    expect(parser.inPaste).toBe(true);
    expect(parser.flush()).toEqual([]);
    const events = parser.feed("[201~");
    expect(events).toMatchObject([{ name: "paste", text: "some text" }]);
    expect(names(parser.feed("abc\x03\r"))).toEqual(["text", "c", "return"]);
    expect(parser.inPaste).toBe(false);
  });

  it("ignores out-of-range code points instead of throwing", () => {
    expect(() => parse("\x1b[1114112u")).not.toThrow();
    expect(names(parse("\x1b[1114112u"))).toEqual(["response"]);
    expect(names(parse("\x1b[27;2;99999999~"))).toEqual(["response"]);
    expect(names(parse("\x1b[55296u"))).toEqual(["response"]); // lone surrogate
  });

  it("flush emits a pending lone escape", () => {
    const parser = new KeyParser();
    expect(parser.feed("\x1b[")).toEqual([]);
    expect(parser.flush()[0].name).toBe("response");
  });
});
