import { describe, expect, it } from "vitest";
import { renderToolResult } from "./render-result.js";

describe("renderToolResult", () => {
  it("returns strings verbatim (real newlines, no JSON escaping)", () => {
    const diff = '--- a/f\n+++ b/f\n@@\n-"old"\n+"new"';
    expect(renderToolResult("edit_file", diff)).toBe(diff);
    expect(renderToolResult("edit_file", "")).toBe("(empty output)");
  });

  it("renders file reads with a header and unescaped content", () => {
    const text = renderToolResult("read_file", { content: '1|const s = "a\\nb";\n2|x', path: "src/a.ts", totalLines: 2 });
    expect(text).toBe('src/a.ts (2 lines)\n1|const s = "a\\nb";\n2|x');
  });

  it("renders shell output with exit code, timeout, truncation notes", () => {
    expect(renderToolResult("shell", { stdout: "hi\nthere", exitCode: 0 })).toBe("hi\nthere\n[exit code: 0]");
    expect(renderToolResult("shell", { stdout: "", exitCode: 124, timedOut: true, note: "Command exceeded 120s" })).toBe(
      "(no output)\n[exit code: 124, timed out]\n[Command exceeded 120s]",
    );
    expect(
      renderToolResult("shell", { stdout: "x", exitCode: 0, truncated: true, fullOutputFile: "/tmp/o.log" }),
    ).toContain("complete output saved at /tmp/o.log");
  });

  it("renders errors, harness notes and denials", () => {
    expect(renderToolResult("edit_file", { error: "Edit target not found" })).toBe("Error: Edit target not found");
    expect(renderToolResult("shell", { error: "no", denied: true })).toBe("Error: no");
    expect(renderToolResult("grep", { matches: "a.ts:1:x", exitCode: 0, harnessNote: "Try a different approach." })).toBe(
      "a.ts:1:x\n[harness: Try a different approach.]",
    );
  });

  it("unwraps annotated outputs", () => {
    expect(renderToolResult("edit_file", { output: "diff text", harnessNote: "Arguments adjusted: file_path → path." })).toBe(
      "diff text\n[harness: Arguments adjusted: file_path → path.]",
    );
  });

  it("renders write, plan, glob, delete", () => {
    expect(renderToolResult("write_file", { path: "a.txt", bytesWritten: 3, created: true, diff: "+x" })).toBe(
      "Created a.txt (3 bytes)\n+x",
    );
    expect(
      renderToolResult("update_plan", { ok: true, steps: [{ step: "a", status: "completed" }, { step: "b", status: "in_progress" }] }),
    ).toBe("[x] a\n[~] b");
    expect(renderToolResult("glob", { matches: ["a", "b"], content: "a\nb" })).toBe("a\nb");
    expect(renderToolResult("grep", { matches: "(no matches)", exitCode: 1 })).toBe("(no matches)");
    expect(renderToolResult("delete_file", { path: "x" })).toBe("Deleted x");
  });

  it("renders MCP text results as real text, with structured data appended", () => {
    expect(renderToolResult("mcp__fs__read", { text: "line1\nline2" })).toBe("line1\nline2");
    expect(renderToolResult("mcp__x__y", { text: "ok", structured: { n: 1 } })).toBe('ok\n\n{\n  "n": 1\n}');
    expect(renderToolResult("mcp__x__y", { structured: [1, 2] })).toBe("[\n  1,\n  2\n]");
  });

  it("falls back to compact JSON for unknown tools", () => {
    expect(renderToolResult("mcp__x__y", { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(renderToolResult("mcp__x__y", { harnessNote: "n" })).toBe("(ok)\n[harness: n]");
  });
});
