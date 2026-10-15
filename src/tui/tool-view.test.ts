import { describe, expect, it } from "vitest";
import { generateDiff } from "../utils/diff.js";
import { plainStyle, Style } from "./style.js";
import { activityLabel, describeCall, renderToolCard } from "./tool-view.js";
import { stripAnsi, visibleWidth } from "./width.js";

const style = plainStyle();
const card = (name: string, args: Record<string, unknown>, result: unknown, extra: { verbose?: boolean; durationMs?: number; width?: number } = {}): string[] =>
  renderToolCard({ name, arguments: args }, result, { style, width: extra.width ?? 80, verbose: extra.verbose ?? false, durationMs: extra.durationMs });

describe("describeCall", () => {
  it("uses friendly titles and the key argument", () => {
    expect(describeCall({ name: "shell", arguments: { command: "npm test" } })).toEqual({ title: "Run", detail: "npm test" });
    expect(describeCall({ name: "read_file", arguments: { path: "a.ts", offset: 10, limit: 20 } })).toEqual({ title: "Read", detail: "a.ts (10–29)" });
    expect(describeCall({ name: "grep", arguments: { pattern: "foo", path: "src" } })).toEqual({ title: "Search", detail: '"foo" in src' });
  });

  it("collapses multi-line commands and marks background jobs", () => {
    expect(describeCall({ name: "shell", arguments: { command: "echo a\necho b" } }).detail).toBe("echo a …");
    expect(describeCall({ name: "shell", arguments: { command: "node server.js", background: true } }).detail).toContain("(background)");
  });

  it("names MCP tools by server and tool", () => {
    expect(describeCall({ name: "mcp__github__create_issue", arguments: { title: "x" } }).title).toBe("github › create_issue");
  });

  it("lists patched files for apply_patch", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Add File: b.ts\n+z\n*** End Patch";
    expect(describeCall({ name: "apply_patch", arguments: { input: patch } }).detail).toBe("a.ts, b.ts");
  });

  it("builds the short activity label", () => {
    expect(activityLabel({ name: "shell", arguments: { command: "make -j8" } })).toBe("run: make -j8");
  });
});

describe("renderToolCard: shell", () => {
  it("shows exit status, timing and an output preview", () => {
    const rows = card("shell", { command: "npm test" }, { stdout: "PASS a\nPASS b\n", exitCode: 0 }, { durationMs: 3200 });
    expect(rows[0]).toBe("● Run  npm test");
    expect(rows[1]).toBe("  ⎿ exit 0 · 3.2s");
    expect(rows.slice(2)).toEqual(["    PASS a", "    PASS b"]);
  });

  it("keeps the head and tail of long output with an ellipsis between", () => {
    const stdout = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n");
    const rows = card("shell", { command: "x" }, { stdout, exitCode: 1 });
    expect(rows[1]).toBe("  ⎿ exit 1");
    expect(rows).toContain("    row 1");
    expect(rows).toContain("    … +24 more lines");
    expect(rows.at(-1)).toBe("    row 30");
  });

  it("shows more output in verbose mode", () => {
    const stdout = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n");
    const rows = card("shell", { command: "x" }, { stdout, exitCode: 0 }, { verbose: true });
    expect(rows.length).toBeGreaterThan(20);
  });

  it("reports timeouts, background jobs and truncation", () => {
    expect(card("shell", { command: "sleep 99" }, { stdout: "", exitCode: 124, timedOut: true })[1]).toContain("timed out");
    expect(card("shell", { command: "srv", background: true }, { stdout: "", exitCode: 0, background: { pid: 42, logFile: "/tmp/x" } })[1]).toBe("  ⎿ started in background (pid 42)");
    expect(card("shell", { command: "x" }, { stdout: "a", exitCode: 0, truncated: true }).join("\n")).toContain("output truncated");
  });

  it("strips escape sequences from command output", () => {
    const rows = card("shell", { command: "x" }, { stdout: "\u001b[31mred\u001b[0m\u001b[2J", exitCode: 0 }).join("\n");
    expect(rows).not.toContain("\u001b");
    expect(rows).toContain("red");
  });

  it("clips long lines to the card width", () => {
    for (const row of card("shell", { command: "x" }, { stdout: "y".repeat(300), exitCode: 0 }, { width: 50 })) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(50);
    }
  });
});

describe("renderToolCard: files and search", () => {
  it("summarizes reads", () => {
    expect(card("read_file", { path: "a.ts" }, { content: "1|a\n2|b\n3|c", path: "a.ts", totalLines: 3 })[1]).toBe("  ⎿ Read 3 lines");
    expect(card("read_file", { path: "a.ts" }, { content: "1|a\n2|b", path: "a.ts", totalLines: 300, continuation: "..." })[1]).toBe("  ⎿ Read 2 of 300 lines");
  });

  it("shows a diff for write_file", () => {
    const rows = card("write_file", { path: "n.txt" }, { path: "n.txt", bytesWritten: 4, created: true, diff: generateDiff("", "a\nb\n", "n.txt") });
    expect(rows[1]).toBe("  ⎿ Created (+2 −0)");
    expect(rows.some((r) => /\+ a$/.test(r))).toBe(true);
  });

  it("shows stats and a diff for edit_file results", () => {
    const text = `Edited a.ts (1 edit; +1 -1).\n${generateDiff("x\ny\n", "x\nz\n", "a.ts")}`;
    const rows = card("edit_file", { path: "a.ts" }, text);
    expect(rows[1]).toBe("  ⎿ +1 −1");
    expect(rows.some((r) => /- y$/.test(r))).toBe(true);
    expect(rows.some((r) => /\+ z$/.test(r))).toBe(true);
  });

  it("summarizes searches and listings", () => {
    expect(card("grep", { pattern: "x" }, { matches: "a.ts:1:x\nb.ts:2:x", exitCode: 0 })[1]).toBe("  ⎿ 2 lines");
    expect(card("grep", { pattern: "x" }, { matches: "(no matches)", exitCode: 1 })[1]).toBe("  ⎿ no matches");
    expect(card("glob", { pattern: "*.ts" }, { matches: ["a.ts", "b.ts"], content: "" })[1]).toBe("  ⎿ 2 files");
    expect(card("list_directory", { path: "." }, { path: ".", entries: ["a", "b", "c"], content: "" })[1]).toBe("  ⎿ 3 entries");
  });

  it("previews subagent reports", () => {
    const rows = card("task", { description: "find auth" }, { report: "Found it in auth.ts\nline two", stopReason: "complete", toolCalls: 4, durationMs: 5000 });
    expect(rows[1]).toBe("  ⎿ 4 tool calls · 5.0s");
    expect(rows).toContain("    Found it in auth.ts");
  });
});

describe("renderToolCard: failures", () => {
  it("shows errors in red with a short message", () => {
    const colored = new Style({ colorDepth: 24, theme: "dark", unicode: true, hyperlinks: false });
    const rows = renderToolCard({ name: "read_file", arguments: { path: "x" } }, { error: "ENOENT: no such file" }, { style: colored, width: 80, verbose: false });
    expect(stripAnsi(rows[1])).toBe("  ⎿ Failed: ENOENT: no such file");
    expect(rows[0]).toContain("38;2;248;113;113");
  });

  it("distinguishes a declined action", () => {
    const rows = card("shell", { command: "rm x" }, { error: "The user declined this action.", denied: true });
    expect(rows[1]).toBe("  ⎿ Declined: The user declined this action.");
  });

  it("limits multi-line errors", () => {
    const rows = card("shell", { command: "x" }, { error: Array.from({ length: 10 }, (_, i) => `err ${i}`).join("\n") });
    expect(rows.at(-1)).toBe("    … +7 more lines");
  });

  it("falls back to a generic preview for unknown and MCP tools", () => {
    const rows = card("mcp__srv__lookup", { q: "x" }, "alpha\nbeta");
    expect(rows[0]).toBe("● srv › lookup  {\"q\":\"x\"}");
    expect(rows).toContain("    alpha");
  });
});
