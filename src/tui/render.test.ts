import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeUi } from "../testing/fake-ui.js";
import { readGitBranch, TerminalRenderer } from "./render.js";
import { plainStyle } from "./style.js";

function make(columns = 100): { ui: FakeUi; r: TerminalRenderer } {
  const ui = new FakeUi();
  ui.columns = columns;
  return { ui, r: new TerminalRenderer("/work/proj", "glm-5.2", ui, plainStyle()) };
}

describe("TerminalRenderer: transcript layout", () => {
  it("echoes the user's message with the prompt glyph and wraps long ones", () => {
    const { ui, r } = make(40);
    r.echoUser("fix the failing test in the parser module please and then run everything again");
    const out = ui.text();
    expect(out.startsWith("❯ fix the failing")).toBe(true);
    expect(out.split("\n").every((line) => line.length <= 40)).toBe(true);
  });

  it("separates different kinds of blocks with one blank line, but keeps tool cards together", () => {
    const { ui, r } = make();
    r.echoUser("go");
    r.assistant("Looking now.");
    r.toolCard({ name: "read_file", arguments: { path: "a.ts" } }, { content: "1|x", path: "a.ts", totalLines: 1 });
    r.toolCard({ name: "read_file", arguments: { path: "b.ts" } }, { content: "1|y", path: "b.ts", totalLines: 1 });
    r.assistant("Done.");
    const rows = ui.printed.join("\n").split("\n");
    const firstCard = rows.findIndex((l) => l.includes("Read  a.ts"));
    const secondCard = rows.findIndex((l) => l.includes("Read  b.ts"));
    expect(rows[firstCard - 1]).toBe("");
    expect(secondCard - firstCard).toBe(2); // header + summary, no blank between cards
    expect(rows[rows.length - 2]).toBe("");
    expect(rows.at(-1)).toBe("  Done.");
  });

  it("indents assistant text and renders markdown", () => {
    const { ui, r } = make();
    r.assistant("# Title\n\n- one\n- two");
    expect(ui.text()).toContain("  Title");
    expect(ui.text()).toContain("  • one");
  });

  it("streams text: finished rows are committed, the unfinished line is the tail", () => {
    const { ui, r } = make();
    r.streamDelta("Hello wor");
    expect(ui.tail).toBe("  Hello wor");
    expect(r.isStreaming()).toBe(true);
    r.streamDelta("ld\nmore");
    expect(ui.text()).toContain("  Hello world");
    expect(ui.tail).toBe("  more");
    r.streamEnd();
    expect(ui.tail).toBeUndefined();
    expect(ui.text()).toContain("  more");
    expect(r.isStreaming()).toBe(false);
    expect(r.getLastAssistantText()).toBe("Hello world\nmore");
  });

  it("counts streamed text toward the token estimate", () => {
    const { ui, r } = make();
    r.streamDelta("x".repeat(400));
    expect(ui.tokens).toBe(100);
  });

  it("shows a plan with progress and markers", () => {
    const { ui, r } = make();
    r.plan([
      { step: "read code", status: "completed" },
      { step: "write fix", status: "in_progress" },
      { step: "run tests", status: "pending" },
    ]);
    const out = ui.text();
    expect(out).toContain("Plan 1/3");
    expect(out).toContain("✔ read code");
    expect(out).toContain("▸ write fix");
    expect(out).toContain("○ run tests");
  });

  it("boxes receipts and wraps long lines inside the box", () => {
    const { ui, r } = make(60);
    r.receipt(["✔ 2 commands ran", "⚠ files changed but nothing was run to verify them, which is worth a look before landing"]);
    const rows = ui.text().split("\n");
    expect(rows[0]).toMatch(/^ {2}╭─ receipt ─+/);
    expect(rows.some((l) => l.includes("│ ⚠ files changed"))).toBe(true);
    expect(rows.at(-1)).toMatch(/^ {2}╰─+/);
    expect(rows.every((l) => l.length <= 62)).toBe(true);
  });

  it("summarizes a turn only when something worth reporting happened", () => {
    const { ui, r } = make();
    r.turnSummary({ durationMs: 1200, toolCalls: 0, inputTokens: 10, outputTokens: 5, stopReason: "complete" });
    expect(ui.printed).toHaveLength(0);
    r.turnSummary({ durationMs: 23_000, toolCalls: 4, inputTokens: 3100, outputTokens: 1250, stopReason: "complete" });
    expect(ui.text()).toContain("Worked for 23s · 4 tool calls · 3.1k in · 1.3k out");
  });

  it("wraps long notices under their own indentation", () => {
    const { ui, r } = make(50);
    r.info("  key  " + "word ".repeat(30));
    const rows = ui.text().split("\n");
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((l) => l.length <= 50)).toBe(true);
    expect(rows.slice(1).every((l) => l.startsWith("  "))).toBe(true);
  });

  it("strips terminal escapes from anything it prints", () => {
    const { ui, r } = make();
    r.info("a\u001b]0;pwned\u0007b\u001b[2Jc");
    r.assistant("x\u001b[31my");
    r.error("bad\u001b[H");
    expect(ui.text()).not.toContain("\u001b");
  });

  it("prints a compact welcome on short or narrow terminals and the banner on large ones", () => {
    const narrow = make(60);
    narrow.r.welcome({ version: "9.9.9", model: "glm-5.2", provider: "zai", cwd: "/work/proj" });
    expect(narrow.ui.text()).toContain("RevCode v9.9.9");
    expect(narrow.ui.text()).toContain("glm-5.2 (zai)");
    expect(narrow.ui.text()).toContain("Tip:");
    expect(narrow.ui.text()).not.toContain("██");
  });

  it("builds the status model from live sources", () => {
    const { r } = make();
    let mode = "ask";
    r.setModeSource(() => mode);
    r.setContextPercent(42.4);
    r.updateModel("glm-4.7");
    mode = "plan";
    expect(r.statusModel()).toMatchObject({ cwd: "/work/proj", mode: "plan", model: "glm-4.7", contextPercent: 42 });
  });

  it("toggles verbose output", () => {
    const { r } = make();
    expect(r.verbose).toBe(false);
    expect(r.toggleVerbose()).toBe(true);
  });
});

describe("readGitBranch", () => {
  it("reads a branch, a detached SHA, and a worktree pointer without spawning git", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-git-"));
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
    expect(readGitBranch(dir)).toBe("feature/x");
    expect(readGitBranch(path.join(dir, "sub"))).toBe("feature/x");
    writeFileSync(path.join(dir, ".git", "HEAD"), "0123456789abcdef\n");
    expect(readGitBranch(dir)).toBe("0123456");

    const wt = mkdtempSync(path.join(os.tmpdir(), "revcode-wt-"));
    mkdirSync(path.join(wt, "gitdir"));
    writeFileSync(path.join(wt, "gitdir", "HEAD"), "ref: refs/heads/wt-branch\n");
    writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(wt, "gitdir")}\n`);
    expect(readGitBranch(wt)).toBe("wt-branch");
  });

  it("returns undefined outside a repository", () => {
    expect(readGitBranch(mkdtempSync(path.join(os.tmpdir(), "revcode-nogit-")))).toBeUndefined();
  });
});

describe("TerminalRenderer: live signals", () => {
  it("shows the latest reasoning sentence as a hint and clears it when text starts", () => {
    const { ui, r } = make();
    r.reasoningDelta("First I should read the file. Then I need to check whether the loop");
    expect(ui.thought).toBe("Then I need to check whether the loop");
    r.streamDelta("Here is the answer");
    expect(ui.thought).toBeUndefined();
  });

  it("shows the newest non-empty line of command output", () => {
    const { ui, r } = make();
    r.toolOutputChunk("compiling a\ncompiling b\n\n");
    expect(ui.toolOutput).toBe("compiling b");
    r.toolOutputChunk("\u001b[32mdone\u001b[0m\n");
    expect(ui.toolOutput).toBe("done");
  });
});
