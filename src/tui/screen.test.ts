import { describe, expect, it } from "vitest";
import { MiniTerminal } from "../testing/mini-terminal.js";
import { LiveScreen, type ScreenOut } from "./screen.js";

function setup(cols = 40, rows = 12): { term: MiniTerminal; screen: LiveScreen; out: ScreenOut & { writes: string[] } } {
  const term = new MiniTerminal(cols, rows);
  const out = {
    writes: [] as string[],
    get columns() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write(data: string) {
      out.writes.push(data);
      term.write(data);
    },
  };
  return { term, screen: new LiveScreen(out), out };
}

const frame = (...lines: string[]) => ({ lines, cursor: { row: 1, col: 3 } });

describe("LiveScreen", () => {
  it("draws the block and parks the cursor in the prompt", () => {
    const { term, screen } = setup();
    screen.draw({ lines: ["---", "> hi", "---", "status"], cursor: { row: 1, col: 4 } });
    expect(term.lines().slice(0, 4)).toEqual(["---", "> hi", "---", "status"]);
    expect([term.y, term.x]).toEqual([1, 4]);
    expect(term.cursorVisible).toBe(true);
  });

  it("redraws in place without leaving ghost rows when the block shrinks or grows", () => {
    const { term, screen } = setup();
    screen.draw(frame("---", "> a", "---", "menu 1", "menu 2", "status"));
    screen.draw(frame("---", "> a", "---", "status"));
    expect(term.lines().slice(0, 6)).toEqual(["---", "> a", "---", "status", "", ""]);
    screen.draw(frame("---", "> a", "---", "m1", "m2", "m3", "status"));
    expect(term.lines().slice(0, 7)).toEqual(["---", "> a", "---", "m1", "m2", "m3", "status"]);
  });

  it("commits printed text above the block, which stays at the bottom", () => {
    const { term, screen } = setup();
    screen.draw(frame("---", ">", "---", "status"));
    screen.print("hello\nworld");
    expect(term.lines().slice(0, 6)).toEqual(["hello", "world", "---", ">", "---", "status"]);
    screen.print("more");
    expect(term.lines().slice(0, 7)).toEqual(["hello", "world", "more", "---", ">", "---", "status"]);
  });

  it("treats text as rows joined by newlines: an empty string is a blank row", () => {
    const { term, screen } = setup();
    screen.draw(frame("---", "> a", "---"));
    screen.print("one");
    screen.print("");
    screen.print("two\nthree");
    screen.print("four\n");
    expect(term.lines().slice(0, 9)).toEqual(["one", "", "two", "three", "four", "", "---", "> a", "---"]);
  });

  it("prints before the first draw as plain text", () => {
    const { term, screen } = setup();
    screen.print("banner");
    screen.draw(frame("---", ">", "---"));
    expect(term.lines().slice(0, 4)).toEqual(["banner", "---", ">", "---"]);
  });

  it("scrolls printed text into scrollback while keeping the block pinned", () => {
    const { term, screen } = setup(40, 8);
    screen.draw(frame("---", ">", "---", "status"));
    for (let i = 1; i <= 10; i += 1) screen.print(`line ${i}`);
    expect(term.lines().slice(-4)).toEqual(["---", ">", "---", "status"]);
    expect(term.transcript().filter((l) => l.startsWith("line"))).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`));
    expect(term.transcript().filter((l) => l === "status")).toHaveLength(1);
  });

  it("never leaves duplicate frames after many redraws near the bottom", () => {
    const { term, screen } = setup(40, 8);
    screen.print("a\nb\nc\nd\ne");
    for (let i = 0; i < 30; i += 1) screen.draw(frame("---", `> ${"x".repeat(i % 5)}`, "---", `status ${i % 3}`));
    const rules = term.transcript().filter((l) => l === "---");
    expect(rules).toHaveLength(2);
  });

  it("clips frame rows so they can never wrap", () => {
    const { term, screen } = setup(20, 8);
    screen.draw({ lines: ["x".repeat(50), "ok"], cursor: { row: 1, col: 0 } });
    expect(term.lines()[0].length).toBe(19);
    expect(term.lines()[1]).toBe("ok");
  });

  it("keeps wide characters aligned", () => {
    const { term, screen } = setup(20, 8);
    screen.draw({ lines: ["日本語", "> x"], cursor: { row: 1, col: 3 } });
    screen.draw({ lines: ["日本語", "> xy"], cursor: { row: 1, col: 4 } });
    expect(term.lines().slice(0, 2)).toEqual(["日本語", "> xy"]);
  });

  it("clears the block on release and leaves the cursor at its top", () => {
    const { term, screen } = setup();
    screen.print("keep");
    screen.draw(frame("---", "> a", "---", "status"));
    screen.release();
    expect(term.lines().slice(0, 3)).toEqual(["keep", "", ""]);
    expect([term.y, term.x]).toEqual([1, 0]);
    screen.print("after");
    expect(term.lines().slice(0, 3)).toEqual(["keep", "after", ""]);
  });

  it("drops the oldest rows when the block is taller than the terminal", () => {
    const { term, screen } = setup(30, 6);
    screen.draw({ lines: ["1", "2", "3", "4", "5", "6", "7", "8"], cursor: { row: 7, col: 0 } });
    expect(term.lines().slice(0, 5)).toEqual(["4", "5", "6", "7", "8"]);
  });

  it("recovers after a resize: erases the old block and redraws at the new width", () => {
    const { term, screen, out } = setup(40, 10);
    screen.print("history");
    screen.draw(frame("---", "> a", "---", "status"));
    term.resize(30, 10);
    screen.beginResize();
    screen.draw(frame("-", "> a", "-", "status"));
    expect(term.lines().slice(0, 5)).toEqual(["history", "-", "> a", "-", "status"]);
    expect(out.writes.length).toBeGreaterThan(2);
  });

  it("counts the rows the cursor line reflows into when moving back up after a narrower resize", () => {
    const { term, screen, out } = setup(40, 10);
    screen.draw({ lines: ["---", `> ${"a".repeat(33)}`], cursor: { row: 1, col: 35 } });
    term.resize(20, 10);
    screen.beginResize();
    // 1 row above + the cursor line's own 35 columns now span two rows of 20 (one extra up).
    expect(out.writes.at(-1)).toBe("\u001b[2A\r\u001b[J");
  });

  it("wraps each update in synchronized-output markers and hides the cursor while painting", () => {
    const { screen, out } = setup();
    screen.draw(frame("---", "> a", "---"));
    const write = out.writes.at(-1) as string;
    expect(write.startsWith("\u001b[?2026h")).toBe(true);
    expect(write.endsWith("\u001b[?2026l")).toBe(true);
    expect(write).toContain("\u001b[?25l");
  });

  it("hides the cursor when the frame has none", () => {
    const { term, screen } = setup();
    screen.draw({ lines: ["a", "b"] });
    expect(term.cursorVisible).toBe(false);
  });
});
