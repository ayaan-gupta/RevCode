import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEngine } from "../agent/engine.js";
import { DEFAULT_PROFILE } from "../harness/profile.js";
import { say, ScriptedLlm, toolCall } from "../testing/scripted-llm.js";
import { ToolRegistry } from "../tools/index.js";
import { createUniverseRecorder, truncateToConsistent } from "./recorder.js";
import { formatReceipt, isTestPath, isVerificationCommand, ReceiptCollector } from "./receipts.js";
import { Universe } from "./universe.js";

let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.REVCODE_HOME;
  process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.REVCODE_HOME;
  else process.env.REVCODE_HOME = previousHome;
});

describe("classifiers", () => {
  it.each(["pytest -x", "python3 -m pytest", "npm test", "npm run build", "cargo test", "make", "python3 app.py", "./run.sh", "curl localhost:8080", "tsc --noEmit"])(
    "treats %s as verification",
    (cmd) => expect(isVerificationCommand(cmd)).toBe(true),
  );
  it.each(["ls -la", "cat README.md", "git status", "cd src", "rg foo"])("does not treat %s as verification", (cmd) =>
    expect(isVerificationCommand(cmd)).toBe(false),
  );
  it.each(["tests/test_a.py", "src/foo.test.ts", "pkg/__tests__/x.js", "test_core.py", "conftest.py", "a_test.go"])(
    "%s is a test path",
    (p) => expect(isTestPath(p)).toBe(true),
  );
  it.each(["src/app.py", "README.md", "latest.txt"])("%s is not a test path", (p) => expect(isTestPath(p)).toBe(false));
});

describe("receipts with a real universe and engine", () => {
  async function setup(steps: ConstructorParameters<typeof ScriptedLlm>[0]) {
    const project = mkdtempSync(path.join(os.tmpdir(), "revcode-proj-"));
    mkdirSync(path.join(project, "tests"));
    writeFileSync(path.join(project, "app.py"), "def f():\n    return 1\n");
    writeFileSync(path.join(project, "tests", "test_app.py"), "from app import f\nassert f() == 1\n");
    const universe = await Universe.create({ projectRoot: project });
    const tools = new ToolRegistry({ cwd: universe.workDir });
    const collector = new ReceiptCollector();
    const holder: { engine?: AgentEngine } = {};
    const engine: AgentEngine = new AgentEngine({
      cwd: universe.workDir,
      llm: new ScriptedLlm(steps),
      profile: DEFAULT_PROFILE,
      systemPrompt: "sys",
      tools,
      maxIterations: 10,
      middleware: [
        collector.middleware(),
        createUniverseRecorder(universe, {
          isReadOnly: (n) => tools.isReadOnly(n),
          context: () => ({ messageCount: holder.engine?.messages.length ?? 0, turn: 1 }),
        }),
      ],
    });
    holder.engine = engine;
    return { engine, universe, collector, tools };
  }


  it("checkpoints each mutating call and produces an honest receipt", async () => {
    const { engine, universe, collector, tools } = await setup([
      toolCall("read_file", { path: "app.py" }),
      toolCall("edit_file", { path: "app.py", edits: [{ oldText: "return 1", newText: "return 2" }] }),
      toolCall("edit_file", { path: "tests/test_app.py", edits: [{ oldText: "== 1", newText: "== 2" }] }),
      toolCall("shell", { command: "PYTHONPATH=. python3 tests/test_app.py" }),
      say("done"),
    ]);
    const before = (await universe.snapshotHead("turn start"));
    const result = await engine.runTurn("fix it");
    const after = await universe.snapshotHead("turn end");

    const kinds = universe.checkpoints().filter((c) => c.tool).map((c) => `${c.tool}:${c.changed}`);
    expect(kinds).toEqual(["edit_file:true", "edit_file:true", "shell:false"]);

    const files = await universe.changesBetween(before, after);
    const existed = await universe.existedAtBase(files.map((f) => f.path));
    const receipt = collector.finalize({ turn: 1, durationMs: result.durationMs, stopReason: result.stopReason, files, existedBefore: existed });

    expect(receipt.files.map((f) => f.path).sort()).toEqual(["app.py", "tests/test_app.py"]);
    expect(receipt.testsModified).toEqual(["tests/test_app.py"]);
    expect(receipt.verification).toMatchObject({ ran: true, afterLastChange: true, exitCode: 0 });
    const text = formatReceipt(receipt).join("\n");
    expect(text).toContain("2 files changed");
    expect(text).toContain("modified an existing test file: tests/test_app.py");
    tools.dispose();
  });

  it("flags unverified changes", async () => {
    const { engine, universe, collector, tools } = await setup([
      toolCall("write_file", { path: "new.txt", content: "hi\n" }),
      say("done"),
    ]);
    const before = await universe.snapshotHead("s");
    const result = await engine.runTurn("write");
    const files = await universe.changesBetween(before, await universe.snapshotHead("e"));
    const receipt = collector.finalize({ turn: 1, durationMs: 1, stopReason: result.stopReason, files });
    expect(formatReceipt(receipt).join("\n")).toContain("nothing was run to verify");
    tools.dispose();
  });
});

describe("truncateToConsistent", () => {
  const user = { role: "user" };
  const assistant = (n: number) => ({ role: "assistant", toolCalls: Array.from({ length: n }, () => ({})) });
  const tool = { role: "tool" };

  it("drops a dangling assistant tool call", () => {
    const msgs = [{ role: "system" }, user, assistant(1), tool, assistant(1)];
    expect(truncateToConsistent(msgs, 5)).toHaveLength(4);
  });

  it("drops incomplete tool-result groups", () => {
    const msgs = [{ role: "system" }, user, assistant(2), tool, tool];
    expect(truncateToConsistent(msgs, 4)).toHaveLength(2);
    expect(truncateToConsistent(msgs, 5)).toHaveLength(5);
  });

  it("keeps complete turns and never goes below the system message", () => {
    const msgs = [{ role: "system" }, user, { role: "assistant" }];
    expect(truncateToConsistent(msgs, 3)).toHaveLength(3);
    expect(truncateToConsistent(msgs, 0)).toHaveLength(1);
  });
});
