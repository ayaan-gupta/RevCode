import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeUi } from "../testing/fake-ui.js";
import { approvalTitle, confirmYesNo, createTerminalApprover, previewDiffFor } from "./approval.js";
import { TerminalRenderer } from "./render.js";
import { plainStyle } from "./style.js";

function setup(cwd = "/work") {
  const ui = new FakeUi();
  const renderer = new TerminalRenderer(cwd, "m", ui, plainStyle());
  return { ui, renderer };
}

const shellRequest = { tool: "shell", args: { command: "npm install lodash" }, summary: "npm install lodash", reason: "Runs a shell command.", alwaysLabel: "Yes, and don't ask again for `npm install*`" };

describe("previewDiffFor", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-approve-"));
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");

  it("diffs a write_file against the existing content", () => {
    const diff = previewDiffFor("write_file", { path: "a.txt", content: "one\nTWO\nthree\n" }, dir) as string;
    expect(diff).toContain("-two");
    expect(diff).toContain("+TWO");
  });

  it("shows a new file as all additions", () => {
    const diff = previewDiffFor("write_file", { path: "new.txt", content: "hello\n" }, dir) as string;
    expect(diff).toContain("+hello");
  });

  it("applies edit_file edits to compute the diff", () => {
    const diff = previewDiffFor("edit_file", { path: "a.txt", edits: [{ oldText: "two", newText: "2" }] }, dir) as string;
    expect(diff).toContain("-two");
    expect(diff).toContain("+2");
  });

  it("falls back to the requested change when the text does not match exactly", () => {
    const diff = previewDiffFor("edit_file", { path: "a.txt", edits: [{ oldText: "tw0", newText: "2" }] }, dir) as string;
    expect(diff).toContain("-tw0");
  });

  it("returns undefined for unknown tools or missing arguments", () => {
    expect(previewDiffFor("shell", { command: "ls" }, dir)).toBeUndefined();
    expect(previewDiffFor("write_file", {}, dir)).toBeUndefined();
  });
});

describe("approvalTitle", () => {
  it("shows the command for shell requests", () => {
    const { renderer } = setup();
    const rows = approvalTitle(shellRequest, { renderer, cwd: () => "/work" }, 10);
    expect(rows[0]).toBe("⚠ Run this command?");
    expect(rows[1]).toBe("  $ npm install lodash");
  });

  it("shows a diff preview for edits", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-approve-"));
    writeFileSync(path.join(dir, "f.ts"), "let a = 1;\n");
    const { renderer } = setup(dir);
    const rows = approvalTitle({ tool: "edit_file", args: { path: "f.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] }, summary: "edit_file f.ts", reason: "Modifies files." }, { renderer, cwd: () => dir }, 12);
    expect(rows[0]).toBe("⚠ Make this change?");
    expect(rows[1]).toBe("  Edit  f.ts");
    expect(rows.join("\n")).toMatch(/- let a = 1;/);
    expect(rows.join("\n")).toMatch(/\+ let a = 2;/);
  });

  it("colors a patch preview line by line", () => {
    const { renderer } = setup();
    const patch = "*** Begin Patch\n*** Update File: x.ts\n@@\n-old\n+new\n*** End Patch";
    const rows = approvalTitle({ tool: "apply_patch", args: { input: patch }, summary: "apply_patch", reason: "Modifies files." }, { renderer, cwd: () => "/work" }, 12);
    expect(rows.join("\n")).toContain("Update x.ts");
    expect(rows.join("\n")).toContain("-old");
    expect(rows.join("\n")).toContain("+new");
  });

  it("truncates very long commands", () => {
    const { renderer } = setup();
    const command = Array.from({ length: 20 }, (_, i) => `echo ${i}`).join("\n");
    const rows = approvalTitle({ ...shellRequest, args: { command } }, { renderer, cwd: () => "/work" }, 10);
    expect(rows.join("\n")).toContain("+12 more lines");
  });
});

describe("createTerminalApprover", () => {
  it("maps the choices to decisions and passes the always-label through", async () => {
    const { ui, renderer } = setup();
    const approve = createTerminalApprover({ renderer, cwd: () => "/work" });
    ui.answerSelect(0, 1);
    expect(await approve(shellRequest)).toEqual({ answer: "allow" });
    expect(await approve(shellRequest)).toEqual({ answer: "always" });
    expect(ui.selects[0].options[1].label).toBe("Yes, and don't ask again for `npm install*`");
    expect(ui.selects[0].hotkeys).toEqual({ y: 0, a: 1, n: 2 });
  });

  it("asks what to do instead when declining, and returns the note", async () => {
    const { ui, renderer } = setup();
    const approve = createTerminalApprover({ renderer, cwd: () => "/work" });
    ui.answerSelect(2).answerPrompt("  use make instead ");
    expect(await approve(shellRequest)).toEqual({ answer: "deny", feedback: "use make instead" });
    ui.answerSelect(2).answerPrompt("");
    expect(await approve(shellRequest)).toEqual({ answer: "deny", feedback: undefined });
  });

  it("Esc declines and stops the task", async () => {
    const { ui, renderer } = setup();
    const onCancel = vi.fn();
    const approve = createTerminalApprover({ renderer, cwd: () => "/work", onCancel });
    ui.answerSelect(undefined);
    expect(await approve(shellRequest)).toEqual({ answer: "deny" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("denies when there is nobody to ask", async () => {
    const ui = new FakeUi({ interactive: false });
    const renderer = new TerminalRenderer("/work", "m", ui, plainStyle());
    expect(await createTerminalApprover({ renderer, cwd: () => "/work" })(shellRequest)).toEqual({ answer: "deny" });
  });
});

describe("confirmYesNo", () => {
  it("returns true only for Yes", async () => {
    const { ui, renderer } = setup();
    ui.answerSelect(0, 1, undefined);
    expect(await confirmYesNo(renderer, "Land it?")).toBe(true);
    expect(await confirmYesNo(renderer, "Land it?")).toBe(false);
    expect(await confirmYesNo(renderer, "Land it?")).toBe(false);
    expect(ui.selects[0].cancelIndex).toBe(1);
  });
});
