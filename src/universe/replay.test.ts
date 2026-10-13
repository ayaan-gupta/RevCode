import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultArgs } from "../cli.js";
import { say, ScriptedLlm, toolCall } from "../testing/scripted-llm.js";
import { compareUniverses, formatComparison } from "./compare.js";
import { escapeHtml, renderUniverseHtml } from "./export-html.js";
import { replayUniverse } from "./replay.js";
import { Universe } from "./universe.js";

let previousHome: string | undefined;
let project: string;

beforeEach(() => {
  previousHome = process.env.REVCODE_HOME;
  process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  project = mkdtempSync(path.join(os.tmpdir(), "revcode-proj-"));
  mkdirSync(path.join(project, "src"));
  writeFileSync(path.join(project, "src", "a.txt"), "original\n");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.REVCODE_HOME;
  else process.env.REVCODE_HOME = previousHome;
});

const args = { ...defaultArgs(), snapshot: false, mcp: false, hooks: false, maxIterations: 12 };

describe("replay + compare + export", () => {
  it("replays recorded prompts from the base state on another model and compares the results", async () => {
    const original = await Universe.create({ projectRoot: project, model: "model-a", provider: "local-test" });
    original.recordPrompt(1, "create hello.txt containing hi");
    writeFileSync(path.join(original.workDir, "hello.txt"), "hi\n");
    await original.checkpoint({ kind: "tool", tool: "write_file", summary: "hello.txt" });
    await new Promise((resolve) => setTimeout(resolve, 3));

    const llm = new ScriptedLlm([
      toolCall("write_file", { path: "hello.txt", content: "HELLO\n" }),
      toolCall("shell", { command: "cat hello.txt" }),
      say("done"),
    ]);
    const progress: string[] = [];
    const replay = await replayUniverse(original, {
      args,
      model: "model-b",
      provider: "local-test",
      llm,
      onProgress: (m) => progress.push(m),
    });

    expect(replay.turns).toHaveLength(1);
    expect(replay.turns[0].result.stopReason).toBe("complete");
    expect(readFileSync(path.join(replay.universe.workDir, "hello.txt"), "utf8")).toBe("HELLO\n");
    expect(replay.universe.meta.parentId).toBe(original.id);
    expect(replay.universe.meta.model).toBe("model-b");
    expect(replay.universe.prompts().map((p) => p.text)).toEqual(["create hello.txt containing hi"]);
    expect(progress.join(" ")).toContain("turn 1/1");

    const comparison = await compareUniverses(original, replay.universe, { verify: "grep -q '^hi$' hello.txt" });
    expect(comparison.a.verify?.passed).toBe(true);
    expect(comparison.b.verify?.passed).toBe(false);
    expect(comparison.differing).toEqual([{ path: "hello.txt", status: "different" }]);
    const text = formatComparison(comparison).join("\n");
    expect(text).toContain("PASS");
    expect(text).toContain("FAIL");
    expect(text).toContain("hello.txt");
  });

  it("refuses to replay a universe with no recorded prompts", async () => {
    const u = await Universe.create({ projectRoot: project });
    await expect(replayUniverse(u, { args, model: "m", llm: new ScriptedLlm([say("x")]) })).rejects.toThrow(/no recorded prompts/);
  });

  it("renders a self-contained, escaped HTML report", async () => {
    const u = await Universe.create({ projectRoot: project, model: "glm-5.2", provider: "zai" });
    u.recordPrompt(1, "fix <script>alert(1)</script> & stuff");
    writeFileSync(path.join(u.workDir, "src", "a.txt"), "changed <b>bold</b>\n");
    await u.checkpoint({ kind: "tool", tool: "edit_file", summary: "edit src/a.txt" });
    u.appendTimeline({
      type: "receipt", at: new Date().toISOString(), turn: 1, durationMs: 4200, stopReason: "complete", toolCalls: 2, toolErrors: 0,
      commands: [{ command: "pytest -q", exitCode: 1, durationMs: 100, timedOut: false, background: false, verification: true, seq: 2 }],
      files: [{ path: "src/a.txt", status: "M", insertions: 1, deletions: 1 }], testsModified: [], testsAdded: [],
      verification: { ran: true, afterLastChange: true, command: "pytest -q", exitCode: 1 },
    });

    const html = await renderUniverseHtml(u);
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("changed &lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("pytest -q");
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(html).toContain("glm-5.2");
  });

  it("escapes html metacharacters", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});
