import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../harness/profile.js";
import { say, ScriptedLlm, toolCall } from "../testing/scripted-llm.js";
import { killProcessesInDir, runDynoTask } from "./runner.js";
import type { DynoTask } from "./types.js";

const helloTask: DynoTask = {
  id: "write-hello",
  title: "write hello",
  category: "implement",
  difficulty: 1,
  instruction: "Create hello.txt containing exactly: hello",
  maxIterations: 8,
  timeoutSec: 60,
  setup(dir) {
    writeFileSync(path.join(dir, "README.md"), "workspace\n");
  },
  grade(dir) {
    const file = path.join(dir, "hello.txt");
    if (!existsSync(file)) return { passed: false, detail: "hello.txt missing" };
    const ok = readFileSync(file, "utf8").trim() === "hello";
    return { passed: ok, detail: ok ? "ok" : "wrong content" };
  },
  oracle(dir) {
    writeFileSync(path.join(dir, "hello.txt"), "hello\n");
  },
};

describe("runDynoTask", () => {
  it("sets up, lets the agent work, and grades the result", async () => {
    const llm = new ScriptedLlm([
      toolCall("write_file", { path: "hello.txt", content: "hello\n" }),
      toolCall("shell", { command: "cat hello.txt" }),
      say("done"),
      say("confirmed"),
    ]);
    const result = await runDynoTask({ task: helloTask, profile: DEFAULT_PROFILE, llm, model: "scripted", provider: "local-test" });
    expect(result).toMatchObject({ taskId: "write-hello", passed: true, stopReason: "complete", toolCalls: 2 });
    expect(result.detail).toBe("ok");
  });

  it("records a failure with the grader's reason when the agent does the wrong thing", async () => {
    const llm = new ScriptedLlm([toolCall("write_file", { path: "hello.txt", content: "nope\n" }), say("done"), say("done")]);
    const result = await runDynoTask({ task: helloTask, profile: DEFAULT_PROFILE, llm, model: "scripted", provider: "local-test" });
    expect(result.passed).toBe(false);
    expect(result.detail).toBe("wrong content");
  });

  it("survives a crashing grader, a failing setup, and a failing model", async () => {
    const crashing: DynoTask = { ...helloTask, grade: () => { throw new Error("boom"); } };
    const r1 = await runDynoTask({ task: crashing, profile: DEFAULT_PROFILE, llm: new ScriptedLlm([say("x")]), model: "m", provider: "local-test" });
    expect(r1.passed).toBe(false);
    expect(r1.detail).toContain("grader crashed: boom");

    const badSetup: DynoTask = { ...helloTask, setup: () => { throw new Error("no disk"); } };
    const r2 = await runDynoTask({ task: badSetup, profile: DEFAULT_PROFILE, llm: new ScriptedLlm([say("x")]), model: "m", provider: "local-test" });
    expect(r2.stopReason).toBe("setup_failed");

    const failing = new ScriptedLlm([() => { throw new Error("api down"); }]);
    const r3 = await runDynoTask({ task: helloTask, profile: DEFAULT_PROFILE, llm: failing, model: "m", provider: "local-test" });
    expect(r3.stopReason).toBe("error");
    expect(r3.error).toBe("api down");
  });

  it("cleans up background processes left in the task directory", async () => {
    const task: DynoTask = { ...helloTask, id: "bg" };
    const llm = new ScriptedLlm([toolCall("shell", { command: "sleep 300", background: true }), say("started"), say("ok")]);
    const before = killProcessesInDir("/definitely/not/a/task/dir");
    expect(before).toBe(0);
    const result = await runDynoTask({ task, profile: DEFAULT_PROFILE, llm, model: "m", provider: "local-test" });
    expect(result.toolCalls).toBe(1);
  });
});
