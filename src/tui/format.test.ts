import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansi.js";
import { extractDiff, formatToolCall, renderDiff } from "./format.js";

describe("formatToolCall", () => {
  it("renders a shell command compactly", () => {
    const out = stripAnsi(formatToolCall("shell", { command: "pip install grpcio" }, true));
    expect(out).toContain("shell");
    expect(out).toContain("pip install grpcio");
    expect(out).not.toContain("{");
  });

  it("marks background commands", () => {
    const out = stripAnsi(
      formatToolCall("shell", { command: "python server.py", background: true }, false),
    );
    expect(out).toContain("(background)");
  });

  it("summarizes edit_file with an edit count", () => {
    const out = stripAnsi(
      formatToolCall("edit_file", { path: "a.py", edits: [{}, {}, {}] }, false),
    );
    expect(out).toContain("a.py");
    expect(out).toContain("3 edits");
  });

  it("summarizes update_plan with a step count", () => {
    const out = stripAnsi(formatToolCall("update_plan", { steps: [{}, {}] }, false));
    expect(out).toContain("2 steps");
  });
});

describe("extractDiff / renderDiff", () => {
  it("extracts a diff from an object result", () => {
    expect(extractDiff({ diff: "@@ -1 +1 @@\n-old\n+new" })).toContain("@@");
    expect(extractDiff({ path: "x" })).toBeUndefined();
  });

  it("indents the diff in plain mode", () => {
    const out = renderDiff("@@ -1 +1 @@\n-old\n+new", false);
    expect(out.split("\n").every((l) => l.startsWith("    "))).toBe(true);
  });

  it("preserves diff content with color", () => {
    const out = stripAnsi(renderDiff("+added line", true));
    expect(out).toContain("+added line");
  });
});
