import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultArgs, resolveArgs, type CliArgs } from "../cli.js";
import { say, ScriptedLlm, toolCall } from "../testing/scripted-llm.js";
import { runTrackedTurn } from "./turn.js";
import { createRuntime, defaultPermissionMode, resolveProfile } from "./setup.js";
import { DEFAULT_PROFILE, saveStoredProfile, withProfile } from "../harness/profile.js";

let previousHome: string | undefined;
let project: string;
const runtimes: Array<{ dispose(): Promise<void> }> = [];

beforeEach(() => {
  previousHome = process.env.REVCODE_HOME;
  process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  project = mkdtempSync(path.join(os.tmpdir(), "revcode-proj-"));
  writeFileSync(path.join(project, "AGENTS.md"), "Always use tabs.");
  mkdirSync(path.join(project, ".git"));
});
afterEach(async () => {
  while (runtimes.length) await runtimes.pop()?.dispose();
  if (previousHome === undefined) delete process.env.REVCODE_HOME;
  else process.env.REVCODE_HOME = previousHome;
});

function args(overrides: Partial<CliArgs> = {}): CliArgs {
  // Overrides go on top of the resolved defaults (resolveArgs only respects flags parsed from argv).
  return { ...resolveArgs({ ...defaultArgs(), cwd: project, headless: overrides.headless ?? false }, { config: {}, warnings: [], files: [] }, {}), ...overrides };
}

describe("createRuntime", () => {
  it("assembles prompt (instructions + snapshot), tools, and gates for a headless run", async () => {
    const llm = new ScriptedLlm([toolCall("write_file", { path: "out.txt", content: "42\n" }), toolCall("shell", { command: "cat out.txt" }), say("done"), say("confirmed")]);
    const rt = await createRuntime({ args: args({ headless: true, mcp: false, hooks: false }), interactive: false, llm, task: "write 42 to out.txt" });
    runtimes.push(rt);

    const system = rt.engine.messages[0].content;
    expect(system).toContain("Always use tabs.");
    expect(system).toContain("Environment snapshot");
    expect(system).toContain("NON-INTERACTIVELY");
    expect(rt.permissions.getMode()).toBe("yolo");
    expect(rt.completion).toBeDefined();
    expect(rt.tools.definitions().map((d) => d.name)).toEqual(expect.arrayContaining(["read_file", "shell", "task", "edit_file"]));

    const { result } = await runTrackedTurn(rt, "write 42 to out.txt");
    expect(result.stopReason).toBe("complete");
    expect(readFileSync(path.join(project, "out.txt"), "utf8")).toBe("42\n");
    // The completion gate challenged once after tool use, then accepted the confirmation.
    expect(rt.engine.messages.some((m) => m.content.includes("audit your work against the ORIGINAL task"))).toBe(true);
    expect(result.finalContent).toBe("confirmed");
  });

  it("is hermetic when asked: no project instructions leak in", async () => {
    const rt = await createRuntime({ args: args({ headless: true, snapshot: false }), interactive: false, hermetic: true, llm: new ScriptedLlm([say("x")]) });
    runtimes.push(rt);
    expect(rt.engine.messages[0].content).not.toContain("Always use tabs.");
    expect(rt.engine.messages[0].content).not.toContain("Environment snapshot");
  });

  it("denies mutations in plan mode and asks nothing in a headless run without an approver", async () => {
    const llm = new ScriptedLlm([toolCall("write_file", { path: "x.txt", content: "no" }), say("ok")]);
    const rt = await createRuntime({ args: args({ permissionMode: "plan", mcp: false, hooks: false }), interactive: false, llm, hermetic: true });
    runtimes.push(rt);
    await rt.engine.runTurn("write");
    const tool = rt.engine.messages.find((m) => m.role === "tool");
    expect(tool?.content).toContain("Plan mode is read-only");
  });

  it("asks for approval in ask mode and honors the answer", async () => {
    const asked: string[] = [];
    const llm = new ScriptedLlm([toolCall("shell", { command: "npm install left-pad" }), say("done")]);
    const rt = await createRuntime({
      args: args({ mcp: false, hooks: false }),
      interactive: true,
      llm,
      hermetic: true,
      approver: async (request) => {
        asked.push(request.summary);
        return "deny";
      },
    });
    runtimes.push(rt);
    expect(rt.permissions.getMode()).toBe("ask");
    await rt.engine.runTurn("install");
    expect(asked).toEqual(["npm install left-pad"]);
    expect(rt.engine.messages.find((m) => m.role === "tool")?.content).toContain("declined");
  });

  it("runs inside a universe: file tools are confined to the copy and nothing lands automatically", async () => {
    writeFileSync(path.join(project, "a.txt"), "original\n");
    const llm = new ScriptedLlm([
      toolCall("edit_file", { path: "a.txt", edits: [{ oldText: "original", newText: "changed" }] }),
      toolCall("shell", { command: "cat a.txt" }),
      say("done"),
    ]);
    const rt = await createRuntime({ args: args({ universe: true, mcp: false, hooks: false }), interactive: true, llm, hermetic: true });
    runtimes.push(rt);
    expect(rt.universe).toBeDefined();
    expect(rt.permissions.getMode()).toBe("yolo");
    expect(rt.engine.messages[0].content).toContain("isolated copy");

    const { receipt } = await runTrackedTurn(rt, "change it");
    expect(readFileSync(path.join(project, "a.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(path.join(rt.universe!.workDir, "a.txt"), "utf8")).toBe("changed\n");
    expect(receipt.files.map((f) => f.path)).toEqual(["a.txt"]);
    // `cat` only displays the file; the receipt must not mistake that for a verification run.
    expect(receipt.verification).toMatchObject({ ran: false });
    expect(receipt.commands.map((c) => c.command)).toEqual(["cat a.txt"]);

    const tool = await rt.tools.execute("read_file", { path: "../../../etc/hostname" }).catch((e: Error) => e.message);
    expect(String(tool)).toContain("escapes the working directory");
  });

  it("switches model and reloads the tuned profile for it", async () => {
    saveStoredProfile({
      profile: withProfile(DEFAULT_PROFILE, { promptStyle: "terse" }),
      provider: "local-test",
      model: "tuned-model",
      tunedAt: "2026-01-01T00:00:00.000Z",
    });
    const rt = await createRuntime({ args: args({ provider: "local-test", model: "plain", snapshot: false }), interactive: true, hermetic: true });
    runtimes.push(rt);
    expect(rt.profileSource).toBe("default");
    const before = rt.engine.messages[0].content.length;
    const switched = rt.switchModel("tuned-model");
    expect(switched.profileSource).toBe("tuned");
    expect(rt.profile.promptStyle).toBe("terse");
    expect(rt.engine.messages[0].content.length).toBeLessThan(before);
  });
});

describe("profile and mode resolution", () => {
  it("auto uses a tuned profile when present, default otherwise, and rejects bad files", () => {
    expect(resolveProfile("auto", "zai", "nobody").source).toBe("default");
    saveStoredProfile({ profile: withProfile(DEFAULT_PROFILE, { editMode: "whole" }), provider: "zai", model: "x", tunedAt: "" });
    expect(resolveProfile("auto", "zai", "x")).toMatchObject({ source: "tuned" });
    expect(resolveProfile("default", "zai", "x").source).toBe("default");
    expect(() => resolveProfile("/does/not/exist.json", "zai", "x")).toThrow(/Could not load profile/);
  });

  it("picks yolo for headless and universes, ask for interactive", () => {
    expect(defaultPermissionMode(args({ headless: true }), false)).toBe("yolo");
    expect(defaultPermissionMode(args(), true)).toBe("yolo");
    expect(defaultPermissionMode(args(), false)).toBe("ask");
    expect(defaultPermissionMode(args({ permissionMode: "plan" }), true)).toBe("plan");
  });
});
