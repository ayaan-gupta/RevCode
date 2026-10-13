import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEngine } from "../agent/engine.js";
import { DEFAULT_PROFILE } from "../harness/profile.js";
import type { LlmToolCall } from "../llm/client.js";
import { say, ScriptedLlm, toolCall } from "../testing/scripted-llm.js";
import { ToolRegistry } from "../tools/index.js";
import type { HookEvent, HooksConfig } from "./config.js";
import { HookRunner, MAX_STOP_CONTINUATIONS, type HookRunnerOptions } from "./runner.js";

let tmp: string;
let project: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "revcode-hook-run-"));
  project = path.join(tmp, "project");
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Single-quote a path for embedding in a bash command. */
const q = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const file = (name: string): string => path.join(tmp, name);
const lines = (name: string): string[] => readFileSync(file(name), "utf8").trim().split("\n");

interface HookSpec {
  command: string;
  timeout?: number;
}

/** Build a config with one matcher group per event. */
function config(event: HookEvent, hooks: Array<string | HookSpec>, matcher?: string): HooksConfig {
  return {
    [event]: [
      {
        ...(matcher !== undefined ? { matcher } : {}),
        hooks: hooks.map((hook) => {
          const spec = typeof hook === "string" ? { command: hook } : hook;
          return { type: "command" as const, ...spec };
        }),
      },
    ],
  };
}

function runner(hooks: HooksConfig, options: Partial<HookRunnerOptions> = {}): HookRunner {
  return new HookRunner(hooks, { cwd: project, sessionId: "sess-1", ...options });
}

const call = (name: string, args: Record<string, unknown> = {}, id = "call-1"): LlmToolCall => ({
  id,
  name,
  arguments: args,
});

async function before(hooks: HookRunner, toolCall: LlmToolCall) {
  return hooks.toMiddleware().before?.({ call: toolCall, iteration: 0 });
}

async function after(hooks: HookRunner, toolCall: LlmToolCall, result: unknown) {
  return hooks.toMiddleware().after?.({ call: toolCall, iteration: 0, result, durationMs: 1 });
}

const sh = {
  block: (reason: string) => `echo ${q(reason)} >&2; exit 2`,
  json: (value: unknown) => `echo ${q(JSON.stringify(value))}`,
  count: (name: string) => `echo x >> ${q(file(name))}`,
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // A killed process can linger as a zombie until its (possibly absent) init reaps it.
    return !/^\d+ \([^)]*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

describe("PreToolUse", () => {
  it("vetoes the tool on exit 2 and gives the model stderr as the reason", async () => {
    const hooks = runner(config("PreToolUse", [sh.block("rm -rf is not allowed")], "shell|edit_file"));
    expect(await before(hooks, call("shell", { command: "rm -rf /" }))).toEqual({
      allow: false,
      reason: "rm -rf is not allowed",
    });
    expect(hooks.warnings).toEqual([]);
  });

  it("falls back to a descriptive reason when a blocking hook says nothing", async () => {
    const hooks = runner(config("PreToolUse", ["exit 2"]));
    const decision = await before(hooks, call("shell"));
    expect(decision).toMatchObject({ allow: false });
    expect((decision as { reason: string }).reason).toContain("PreToolUse hook `exit 2`");
  });

  it("only runs for tools the matcher regex selects", async () => {
    const hooks = runner(config("PreToolUse", [`${sh.count("ran")}; exit 2`], "shell|edit_file"));
    expect(await before(hooks, call("read_file"))).toEqual({ allow: true });
    expect(existsSync(file("ran"))).toBe(false);

    expect(await before(hooks, call("edit_file"))).toMatchObject({ allow: false });
    expect(await before(hooks, call("shell", {}, "call-2"))).toMatchObject({ allow: false });
    expect(lines("ran")).toHaveLength(2);
  });

  it.each([undefined, "", "*", ".*"])("runs for every tool when the matcher is %j", async (matcher) => {
    const hooks = runner(config("PreToolUse", [sh.block("no")], matcher));
    expect(await before(hooks, call("anything_at_all"))).toMatchObject({ allow: false, reason: "no" });
  });

  it("passes the event JSON on stdin and the project env vars to the command", async () => {
    const hooks = runner(
      config("PreToolUse", [`cat > ${q(file("stdin.json"))}; echo "$REVCODE_HOOK_EVENT|$REVCODE_PROJECT_DIR|$PWD" > ${q(file("env.txt"))}`]),
    );
    await before(hooks, call("write_file", { path: "a.txt" }, "call-9"));

    expect(JSON.parse(readFileSync(file("stdin.json"), "utf8"))).toEqual({
      hook_event_name: "PreToolUse",
      session_id: "sess-1",
      cwd: project,
      tool_name: "write_file",
      tool_input: { path: "a.txt" },
      tool_use_id: "call-9",
    });
    expect(lines("env.txt")).toEqual([`PreToolUse|${project}|${realpathSync(project)}`]);
  });

  it("applies updatedInput and lets the next hook see the rewritten input", async () => {
    const hooks = runner(
      config("PreToolUse", [
        sh.json({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "echo safe" } } }),
        `cat > ${q(file("second.json"))}`,
      ]),
    );
    const decision = await before(hooks, call("shell", { command: "echo risky" }));

    expect(decision).toEqual({ allow: true, input: { command: "echo safe" } });
    expect(JSON.parse(readFileSync(file("second.json"), "utf8")).tool_input).toEqual({ command: "echo safe" });
  });

  it("stops at the first blocking hook", async () => {
    const hooks = runner(config("PreToolUse", [sh.block("first"), sh.count("second-ran")]));
    expect(await before(hooks, call("shell"))).toMatchObject({ allow: false, reason: "first" });
    expect(existsSync(file("second-ran"))).toBe(false);
  });

  it.each([
    ["decision block", { decision: "block", reason: "policy says no" }, "policy says no"],
    ["permissionDecision deny", { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "denied by hook" } }, "denied by hook"],
    ["permissionDecision deny without a reason", { hookSpecificOutput: { permissionDecision: "deny" } }, "Denied by PreToolUse hook"],
  ])("vetoes on JSON %s", async (_label, output, reason) => {
    const hooks = runner(config("PreToolUse", [sh.json(output)]));
    const decision = await before(hooks, call("shell"));
    expect(decision).toMatchObject({ allow: false });
    expect((decision as { reason: string }).reason).toContain(reason);
    expect(hooks.lastPermissionDecision("call-1")).toBe("deny");
  });

  it("ignores JSON on a blocking exit code; stderr is the reason", async () => {
    const hooks = runner(config("PreToolUse", [`${sh.json({ decision: "approve" })}; echo stderr-wins >&2; exit 2`]));
    expect(await before(hooks, call("shell"))).toMatchObject({ allow: false, reason: "stderr-wins" });
  });

  it("allows the call when the hook is silent", async () => {
    const hooks = runner(config("PreToolUse", ["true"]));
    expect(await before(hooks, call("shell"))).toEqual({ allow: true });
    expect(hooks.lastPermissionDecision("call-1")).toBeUndefined();
  });

  it("turns a non-blocking failure into a warning and lets the tool run", async () => {
    const hooks = runner(config("PreToolUse", ["echo 'lint crashed' >&2; exit 1"]));
    expect(await before(hooks, call("shell"))).toEqual({ allow: true });
    expect(hooks.warnings).toHaveLength(1);
    expect(hooks.warnings[0]).toMatch(/PreToolUse hook `echo 'lint crashed' >&2; exit 1` exited with code 1: lint crashed/);
  });

  it("warns about output that looks like JSON but does not parse", async () => {
    const hooks = runner(config("PreToolUse", ["echo '{\"decision\": \"block\"'"]));
    expect(await before(hooks, call("shell"))).toEqual({ allow: true });
    expect(hooks.warnings[0]).toMatch(/looks like JSON/);
  });

  it("warns about unusable updatedInput and unknown permission decisions", async () => {
    const hooks = runner(
      config("PreToolUse", [
        sh.json({ hookSpecificOutput: { updatedInput: "nope", permissionDecision: "maybe" } }),
      ]),
    );
    expect(await before(hooks, call("shell", { a: 1 }))).toEqual({ allow: true });
    expect(hooks.warnings).toHaveLength(2);
  });

  it("clips very long block reasons", async () => {
    const hooks = runner(config("PreToolUse", ["head -c 600000 /dev/zero | tr '\\0' a >&2; exit 2"]));
    const decision = (await before(hooks, call("shell"))) as { reason: string };
    expect(decision.reason.length).toBeLessThan(4_100);
    expect(decision.reason).toContain("[truncated]");
  });
});

describe("permission integration", () => {
  const permission = (value: string) => sh.json({ hookSpecificOutput: { permissionDecision: value } });

  it.each(["allow", "ask", "deny"] as const)("exposes a %s decision without treating ask as allow", async (value) => {
    const hooks = runner(config("PreToolUse", [permission(value)]));
    const decision = await before(hooks, call("shell"));

    expect(hooks.lastPermissionDecision("call-1")).toBe(value);
    expect(decision).toMatchObject({ allow: value !== "deny" });
  });

  it("combines hooks conservatively: deny beats ask beats allow", async () => {
    const order = (...values: string[]) => runner(config("PreToolUse", values.map(permission)));
    const decide = async (hooks: HookRunner) => {
      await before(hooks, call("shell"));
      return hooks.lastPermissionDecision("call-1");
    };

    expect(await decide(order("allow", "ask"))).toBe("ask");
    expect(await decide(order("ask", "allow"))).toBe("ask");
    expect(await decide(order("allow", "allow"))).toBe("allow");
  });

  it("permissionDecisionFor reuses the middleware's evaluation instead of re-running hooks", async () => {
    const hooks = runner(config("PreToolUse", [`${sh.count("pre")}; ${permission("ask")}`]));
    await before(hooks, call("shell"));
    expect(await hooks.permissionDecisionFor(call("shell"))).toBe("ask");
    expect(lines("pre")).toHaveLength(1);
  });

  it("works when the permission layer asks first: hooks run once and the middleware reuses the result", async () => {
    const hooks = runner(
      config("PreToolUse", [`${sh.count("pre")}; ${sh.json({ decision: "block", reason: "blocked after prefetch" })}`]),
    );
    expect(await hooks.permissionDecisionFor(call("shell", { a: 1 }))).toBe("deny");
    expect(await before(hooks, call("shell", { a: 1 }))).toEqual({ allow: false, reason: "blocked after prefetch" });
    expect(lines("pre")).toHaveLength(1);

    // A later call with the same id is a new call and gets fresh hook runs.
    await before(hooks, call("shell", { a: 1 }));
    expect(lines("pre")).toHaveLength(2);
  });

  it("returns undefined when no hook has an opinion, and forgets the call after it runs", async () => {
    const hooks = runner(config("PreToolUse", [permission("ask")]));
    await before(hooks, call("shell"));
    await after(hooks, call("shell"), { ok: true });
    expect(hooks.lastPermissionDecision("call-1")).toBeUndefined();
    expect(await runner({}).permissionDecisionFor(call("shell"))).toBeUndefined();
  });
});

describe("PostToolUse", () => {
  it("leaves the result alone when hooks have nothing to say", async () => {
    const hooks = runner(config("PostToolUse", ["true"]));
    expect(await after(hooks, call("write_file"), { ok: true })).toBeUndefined();
  });

  it("sends the tool input and response to the hook", async () => {
    const hooks = runner(config("PostToolUse", [`cat > ${q(file("post.json"))}`], "write_file"));
    await after(hooks, call("write_file", { path: "a.ts" }, "c7"), { bytes: 12 });

    expect(JSON.parse(readFileSync(file("post.json"), "utf8"))).toEqual({
      hook_event_name: "PostToolUse",
      session_id: "sess-1",
      cwd: project,
      tool_name: "write_file",
      tool_input: { path: "a.ts" },
      tool_response: { bytes: 12 },
      tool_use_id: "c7",
    });
  });

  it("decorates object results with hookFeedback on exit 2", async () => {
    const hooks = runner(config("PostToolUse", [sh.block("tests are failing")]));
    expect(await after(hooks, call("write_file"), { path: "a.ts", bytes: 3 })).toEqual({
      path: "a.ts",
      bytes: 3,
      hookFeedback: "tests are failing",
    });
  });

  it("wraps non-object results", async () => {
    const hooks = runner(config("PostToolUse", [sh.block("note")]));
    expect(await after(hooks, call("x"), "plain text")).toEqual({ output: "plain text", hookFeedback: "note" });
    expect(await after(hooks, call("x"), ["a"])).toEqual({ output: ["a"], hookFeedback: "note" });
    expect(await after(hooks, call("x"), null)).toEqual({ output: null, hookFeedback: "note" });
  });

  it("collects JSON decision block and additionalContext from several hooks", async () => {
    const hooks = runner(
      config("PostToolUse", [
        sh.json({ decision: "block", reason: "formatting needed" }),
        sh.json({ hookSpecificOutput: { additionalContext: "ran prettier" } }),
      ]),
    );
    expect(await after(hooks, call("edit_file"), { ok: true })).toEqual({
      ok: true,
      hookFeedback: "formatting needed\nran prettier",
    });
  });

  it("carries PreToolUse additionalContext over to the result", async () => {
    const hooks = runner(config("PreToolUse", [sh.json({ hookSpecificOutput: { additionalContext: "careful: prod config" } })]));
    await before(hooks, call("edit_file"));
    expect(await after(hooks, call("edit_file"), { ok: true })).toEqual({ ok: true, hookFeedback: "careful: prod config" });
  });

  it("does not run for non-matching tools", async () => {
    const hooks = runner(config("PostToolUse", [`${sh.count("post")}; exit 2`], "edit_file"));
    expect(await after(hooks, call("read_file"), { ok: true })).toBeUndefined();
    expect(existsSync(file("post"))).toBe(false);
  });
});

describe("UserPromptSubmit", () => {
  it("rejects the prompt on exit 2 with the stderr reason", async () => {
    const hooks = runner(config("UserPromptSubmit", [sh.block("secrets detected in prompt")]));
    expect(await hooks.runUserPromptSubmit("my key is sk-123")).toEqual({ blocked: "secrets detected in prompt" });
  });

  it("rejects on JSON decision block", async () => {
    const hooks = runner(config("UserPromptSubmit", [sh.json({ decision: "block", reason: "not now" })]));
    expect(await hooks.runUserPromptSubmit("hi")).toEqual({ blocked: "not now" });
  });

  it("adds plain stdout and additionalContext as context, in order", async () => {
    const hooks = runner(
      config("UserPromptSubmit", [
        "echo 'Today is Tuesday'",
        sh.json({ hookSpecificOutput: { additionalContext: "branch: main" } }),
        "true",
      ]),
    );
    expect(await hooks.runUserPromptSubmit("what day is it")).toEqual({ context: "Today is Tuesday\nbranch: main" });
  });

  it("sends the prompt on stdin and ignores matchers", async () => {
    const hooks = runner(config("UserPromptSubmit", [`cat > ${q(file("ups.json"))}`], "never-matches-anything"));
    await hooks.runUserPromptSubmit("fix the bug");
    expect(JSON.parse(readFileSync(file("ups.json"), "utf8"))).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      prompt: "fix the bug",
      session_id: "sess-1",
    });
  });

  it("returns an empty result when nothing is configured", async () => {
    expect(await runner({}).runUserPromptSubmit("hi")).toEqual({});
  });

  it("does not treat tool-event stdout as context", async () => {
    const hooks = runner(config("PreToolUse", ["echo some chatter"]));
    expect(await before(hooks, call("shell"))).toEqual({ allow: true });
    expect(await after(hooks, call("shell"), { ok: true })).toBeUndefined();
  });
});

describe("SessionStart", () => {
  it("returns stdout context", async () => {
    const hooks = runner(config("SessionStart", ["echo 'repo: revcode'", sh.json({ hookSpecificOutput: { additionalContext: "node 22" } })]));
    expect(await hooks.runSessionStart()).toBe("repo: revcode\nnode 22");
  });

  it("returns undefined without hooks or output", async () => {
    expect(await runner({}).runSessionStart()).toBeUndefined();
    expect(await runner(config("SessionStart", ["true"])).runSessionStart()).toBeUndefined();
  });

  it("surfaces a blocking exit as a warning since there is nothing to veto", async () => {
    const hooks = runner(config("SessionStart", [sh.block("env not ready")]));
    expect(await hooks.runSessionStart()).toBeUndefined();
    expect(hooks.warnings[0]).toMatch(/SessionStart hook .* exited 2: env not ready/);
  });
});

describe("Stop gate", () => {
  it("allows stopping when there are no Stop hooks or they pass", async () => {
    expect(await runner({}).toFinalGate().check({ finalContent: "done", turnToolCalls: 1 })).toBeUndefined();
    const passing = runner(config("Stop", ["true"]));
    expect(await passing.toFinalGate().check({ finalContent: "done", turnToolCalls: 1 })).toBeUndefined();
  });

  it("sends the model back to work with the hook's reason", async () => {
    const gate = runner(config("Stop", [sh.block("run the tests first")])).toFinalGate();
    const message = await gate.check({ finalContent: "done", turnToolCalls: 2 });
    expect(message).toContain("run the tests first");
    expect(gate.name).toBe("hooks:stop");
  });

  it("also continues on JSON decision block", async () => {
    const gate = runner(config("Stop", [sh.json({ decision: "block", reason: "keep going" })])).toFinalGate();
    expect(await gate.check({ finalContent: "done", turnToolCalls: 0 })).toContain("keep going");
  });

  it("gives up after the continuation cap, warning once", async () => {
    const hooks = runner(config("Stop", [`${sh.count("stop")}; ${sh.block("not done")}`]));
    const gate = hooks.toFinalGate();

    const results: Array<string | undefined> = [];
    for (let i = 0; i < MAX_STOP_CONTINUATIONS + 2; i += 1) {
      results.push(await gate.check({ finalContent: "done", turnToolCalls: 1 }));
    }

    expect(MAX_STOP_CONTINUATIONS).toBe(3);
    expect(results.map((r) => r !== undefined)).toEqual([true, true, true, false, false]);
    expect(lines("stop")).toHaveLength(3);
    expect(hooks.warnings.filter((w) => /Stop hooks asked the model to continue 3 times/.test(w))).toHaveLength(1);
  });

  it("resetStopContinuations restores the budget", async () => {
    const hooks = runner(config("Stop", [sh.block("not done")]));
    const gate = hooks.toFinalGate();
    for (let i = 0; i < MAX_STOP_CONTINUATIONS; i += 1) {
      await gate.check({ finalContent: "x", turnToolCalls: 1 });
    }
    expect(await gate.check({ finalContent: "x", turnToolCalls: 1 })).toBeUndefined();

    hooks.resetStopContinuations();
    expect(await gate.check({ finalContent: "x", turnToolCalls: 1 })).toContain("not done");
  });

  it("passes stop_hook_active: true on re-runs and false again once the hook is satisfied", async () => {
    const hooks = runner(
      config("Stop", [
        `cat >> ${q(file("stop.jsonl"))}; echo >> ${q(file("stop.jsonl"))}; [ -f ${q(file("satisfied"))} ] || { echo again >&2; exit 2; }`,
      ]),
    );
    const gate = hooks.toFinalGate();

    await gate.check({ finalContent: "x", turnToolCalls: 1 });
    await gate.check({ finalContent: "x", turnToolCalls: 1 });
    writeFileSync(file("satisfied"), "");
    expect(await gate.check({ finalContent: "x", turnToolCalls: 1 })).toBeUndefined();
    await gate.check({ finalContent: "x", turnToolCalls: 1 });

    const events = readFileSync(file("stop.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.stop_hook_active)).toEqual([false, true, true, false]);
    expect(events[0]).toMatchObject({ hook_event_name: "Stop", session_id: "sess-1", cwd: project });
  });
});

describe("failure handling", () => {
  it("kills a hook that outlives its timeout and moves on with a warning", async () => {
    const hooks = runner(config("PreToolUse", [{ command: "sleep 5", timeout: 0.3 }]));
    const started = Date.now();
    const decision = await before(hooks, call("shell"));

    expect(Date.now() - started).toBeLessThan(2_500);
    expect(decision).toEqual({ allow: true });
    expect(hooks.warnings).toHaveLength(1);
    expect(hooks.warnings[0]).toMatch(/timed out after 0\.3s and was killed/);
  });

  it("kills the whole process group, not just the shell", async () => {
    const hooks = runner(config("PreToolUse", [{ command: `sleep 30 & echo $! > ${q(file("child.pid"))}; wait`, timeout: 0.4 }]));
    await before(hooks, call("shell"));

    const pid = Number(readFileSync(file("child.pid"), "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    const deadline = Date.now() + 2_000;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(isAlive(pid)).toBe(false);
  });

  it("does not hang on a hook that leaves a background process holding stdout", async () => {
    const hooks = runner(config("SessionStart", ["sleep 2 & echo started"]));
    const started = Date.now();
    expect(await hooks.runSessionStart()).toBe("started");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("reports a hook that cannot start (bad working directory) instead of throwing", async () => {
    const hooks = runner(config("PreToolUse", ["echo hi"]), { cwd: path.join(tmp, "does-not-exist") });
    expect(await before(hooks, call("shell"))).toEqual({ allow: true });
    expect(hooks.warnings[0]).toMatch(/PreToolUse hook `echo hi` could not start/);
  });

  it("copes with a hook that never reads stdin", async () => {
    const hooks = runner(config("PreToolUse", ["exit 0"]));
    expect(await before(hooks, call("write_file", { content: "x".repeat(2_000_000) }))).toEqual({ allow: true });
    expect(hooks.warnings).toEqual([]);
  });

  it("reports a hook killed by a signal", async () => {
    const hooks = runner(config("PostToolUse", ["kill -9 $$"]));
    expect(await after(hooks, call("shell"), { ok: true })).toBeUndefined();
    expect(hooks.warnings[0]).toMatch(/was killed by SIGKILL/);
  });

  it("keeps working when a tool result cannot be serialized", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const hooks = runner(config("PostToolUse", [`cat > ${q(file("cyclic.json"))}`]));
    expect(await after(hooks, call("shell"), cyclic)).toBeUndefined();
    expect(JSON.parse(readFileSync(file("cyclic.json"), "utf8")).tool_response).toBe("[unserializable]");
  });

  it("swallows exceptions from the onWarning callback", async () => {
    const hooks = runner(config("PreToolUse", ["exit 1"]), {
      onWarning: () => {
        throw new Error("ui exploded");
      },
    });
    expect(await before(hooks, call("shell"))).toEqual({ allow: true });
    expect(hooks.warnings).toHaveLength(1);
  });
});

describe("HookRunner.load", () => {
  it("merges files, runs them in order, and reports config problems without failing", async () => {
    const home = path.join(tmp, "home");
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(project, ".revcode"), { recursive: true });
    writeFileSync(
      path.join(home, "hooks.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo global" }] }] } }),
    );
    writeFileSync(path.join(project, ".revcode", "hooks.json"), "{ broken");
    writeFileSync(
      path.join(project, ".revcode", "hooks.local.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo local" }] }],
          Bogus: [],
        },
      }),
    );

    const seen: string[] = [];
    const hooks = HookRunner.load(project, "sess-load", { revcodeHome: home, onWarning: (m) => seen.push(m) });

    expect(hooks.hasHooks("UserPromptSubmit")).toBe(true);
    expect(hooks.hasHooks("Stop")).toBe(false);
    expect(hooks.warnings).toHaveLength(2);
    expect(seen).toEqual(hooks.warnings);
    expect(hooks.warnings[0]).toMatch(/invalid JSON/);
    expect(hooks.warnings[1]).toMatch(/unknown hook event "Bogus"/);
    expect(await hooks.runUserPromptSubmit("hi")).toEqual({ context: "global\nlocal" });
  });

  it("can ignore project hook files for untrusted repositories", () => {
    const home = path.join(tmp, "home");
    mkdirSync(path.join(project, ".revcode"), { recursive: true });
    writeFileSync(
      path.join(project, ".revcode", "hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "echo hi" }] }] } }),
    );
    expect(HookRunner.load(project, "s", { revcodeHome: home, includeProject: false }).hasHooks("Stop")).toBe(false);
    expect(HookRunner.load(project, "s", { revcodeHome: home }).hasHooks("Stop")).toBe(true);
  });

  it("hasHooks is false for groups without commands", () => {
    expect(runner({ Stop: [{ hooks: [] }] }).hasHooks("Stop")).toBe(false);
  });
});

describe("with AgentEngine", () => {
  const registries: ToolRegistry[] = [];
  afterEach(() => {
    while (registries.length) registries.pop()?.dispose();
  });

  function engineWith(hooks: HookRunner, steps: ConstructorParameters<typeof ScriptedLlm>[0]) {
    const tools = new ToolRegistry({ cwd: project });
    registries.push(tools);
    return new AgentEngine({
      cwd: project,
      llm: new ScriptedLlm(steps),
      profile: DEFAULT_PROFILE,
      systemPrompt: "sys",
      tools,
      maxIterations: 8,
      middleware: [hooks.toMiddleware()],
      finalGates: [hooks.toFinalGate()],
    });
  }

  it("a blocking PreToolUse hook stops the tool and the model sees why", async () => {
    const hooks = runner(config("PreToolUse", [sh.block("writes to a.txt are forbidden")], "write_file"));
    const engine = engineWith(hooks, [toolCall("write_file", { path: "a.txt", content: "hi" }), say("understood")]);

    const result = await engine.runTurn("write a file");
    expect(result.stopReason).toBe("complete");
    expect(existsSync(path.join(project, "a.txt"))).toBe(false);
    const toolMessage = engine.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("writes to a.txt are forbidden");
    expect(toolMessage?.content).toContain("denied");
  });

  it("an updatedInput rewrite is what the tool actually receives", async () => {
    const hooks = runner(
      config("PreToolUse", [
        sh.json({ hookSpecificOutput: { updatedInput: { path: "safe.txt", content: "rewritten" } } }),
      ]),
    );
    const engine = engineWith(hooks, [toolCall("write_file", { path: "a.txt", content: "hi" }), say("ok")]);

    await engine.runTurn("write a file");
    expect(existsSync(path.join(project, "a.txt"))).toBe(false);
    expect(readFileSync(path.join(project, "safe.txt"), "utf8")).toBe("rewritten");
  });

  it("PostToolUse feedback reaches the model inside the tool result", async () => {
    writeFileSync(path.join(project, "n.txt"), "data\n");
    const hooks = runner(config("PostToolUse", [sh.block("remember to cite the file")], "read_file"));
    const engine = engineWith(hooks, [toolCall("read_file", { path: "n.txt" }), say("ok")]);

    await engine.runTurn("read it");
    const toolMessage = engine.messages.find((m) => m.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "{}").result.hookFeedback).toBe("remember to cite the file");
  });

  it("a Stop hook pushes the model back once, then the turn completes", async () => {
    const flag = file("tests-ran");
    const hooks = runner(
      config("Stop", [`[ -f ${q(flag)} ] || { touch ${q(flag)}; echo 'run the tests before finishing' >&2; exit 2; }`]),
    );
    const llm = new ScriptedLlm([say("all done"), say("tests pass, really done")]);
    const tools = new ToolRegistry({ cwd: project });
    registries.push(tools);
    const engine = new AgentEngine({
      cwd: project,
      llm,
      profile: DEFAULT_PROFILE,
      systemPrompt: "sys",
      tools,
      maxIterations: 5,
      finalGates: [hooks.toFinalGate()],
    });

    const result = await engine.runTurn("finish up");
    expect(result.stopReason).toBe("complete");
    expect(result.finalContent).toBe("tests pass, really done");
    expect(llm.calls).toHaveLength(2);
    const nudges = engine.messages.filter((m) => m.role === "user" && m.content.includes("run the tests before finishing"));
    expect(nudges).toHaveLength(1);
  });

  it("a never-satisfied Stop hook cannot loop the turn forever", async () => {
    const hooks = runner(config("Stop", [sh.block("never enough")]));
    const llm = new ScriptedLlm([say("done")]);
    const tools = new ToolRegistry({ cwd: project });
    registries.push(tools);
    const engine = new AgentEngine({
      cwd: project,
      llm,
      profile: DEFAULT_PROFILE,
      systemPrompt: "sys",
      tools,
      maxIterations: 20,
      finalGates: [hooks.toFinalGate()],
    });

    const result = await engine.runTurn("finish up");
    expect(result.stopReason).toBe("complete");
    expect(llm.calls).toHaveLength(MAX_STOP_CONTINUATIONS + 1);
  });
});
