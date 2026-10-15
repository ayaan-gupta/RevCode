import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultArgs, resolveArgs, type CliArgs } from "../cli.js";
import { FakeUi } from "../testing/fake-ui.js";
import { say, ScriptedLlm } from "../testing/scripted-llm.js";
import { TerminalRenderer } from "../tui/render.js";
import { builtinSlashCommands } from "../tui/slash-commands.js";
import { plainStyle } from "../tui/style.js";
import { runCommand, suggestedModels, type CommandContext } from "./commands.js";
import { saveSession, type SessionSnapshot } from "./session.js";
import { createRuntime, type Runtime } from "./setup.js";

vi.mock("../tui/clipboard.js", () => ({
  copyToClipboard: vi.fn(async () => "osc52"),
  osc52Sequence: (text: string) => `<osc52:${text}>`,
}));

let previousHome: string | undefined;
let project: string;
let runtime: Runtime;
let ui: FakeUi;
let ctx: CommandContext;
const style = plainStyle();
const spies = { runPrompt: vi.fn(async () => undefined), adoptSession: vi.fn(), refreshStatus: vi.fn(), setModel: vi.fn() };

function args(): CliArgs {
  return { ...resolveArgs({ ...defaultArgs(), cwd: project }, { config: {}, warnings: [], files: [] }, {}), mcp: false, hooks: false, snapshot: false };
}

beforeEach(async () => {
  previousHome = process.env.REVCODE_HOME;
  process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-cmd-home-"));
  project = mkdtempSync(path.join(os.tmpdir(), "revcode-cmd-proj-"));
  Object.values(spies).forEach((spy) => spy.mockClear());
  runtime = await createRuntime({ args: args(), interactive: true, llm: new ScriptedLlm([say("x")]), hermetic: true });
  ui = new FakeUi();
  const renderer = new TerminalRenderer(project, "glm-5.2", ui, style);
  ctx = {
    rt: runtime,
    args: args(),
    renderer,
    style,
    caps: { colorDepth: 0, theme: "dark", unicode: true, hyperlinks: false },
    startedAt: Date.now() - 65_000,
    configFiles: [],
    configWarnings: [],
    slashCommands: () => builtinSlashCommands({ models: () => [], modes: () => [], sessions: () => [] }),
    getModel: () => "glm-5.2",
    setModel: spies.setModel,
    getLastReceipt: () => undefined,
    runPrompt: spies.runPrompt,
    adoptSession: spies.adoptSession,
    refreshStatus: spies.refreshStatus,
    toggleVim: () => true,
  };
});

afterEach(async () => {
  await runtime.dispose();
  if (previousHome === undefined) delete process.env.REVCODE_HOME;
  else process.env.REVCODE_HOME = previousHome;
});

describe("built-in slash commands", () => {
  it("returns false for names it does not own", async () => {
    expect(await runCommand(ctx, "/nope", "")).toBe(false);
  });

  it("/help lists commands, universe commands and keyboard shortcuts", async () => {
    await runCommand(ctx, "/help", "");
    const out = ui.text();
    expect(out).toContain("Commands");
    expect(out).toContain("/status");
    expect(out).toContain("Parallel Universe (start with revcode --universe)");
    expect(out).toContain("Keyboard");
    expect(out).toContain("Shift+Enter");
  });

  it("/status summarizes the session", async () => {
    await runCommand(ctx, "/status", "");
    const out = ui.text();
    expect(out).toContain("glm-5.2");
    expect(out).toContain("ask — prompt before edits");
    expect(out).toContain("none (try /init)");
    expect(out).toMatch(/Session\s+\S+ · 0 turns · 1m 5s/);
  });

  it("/mode sets a mode directly, rejects bad ones, and offers a picker with no argument", async () => {
    await runCommand(ctx, "/mode", "plan");
    expect(runtime.permissions.getMode()).toBe("plan");
    expect(spies.refreshStatus).toHaveBeenCalled();
    await runCommand(ctx, "/mode", "bogus");
    expect(ui.text()).toContain('Unknown mode "bogus"');
    ui.answerSelect(1);
    await runCommand(ctx, "/mode", "");
    expect(runtime.permissions.getMode()).toBe("accept-edits");
    expect(ui.selects[0].options.map((o) => o.label)).toEqual(["ask", "accept-edits", "plan", "yolo"]);
  });

  it("/plan toggles plan mode", async () => {
    await runCommand(ctx, "/plan", "");
    expect(runtime.permissions.getMode()).toBe("plan");
    await runCommand(ctx, "/plan", "");
    expect(runtime.permissions.getMode()).toBe("ask");
  });

  it("/model switches by name and via the picker", async () => {
    await runCommand(ctx, "/model", "glm-4.7");
    expect(spies.setModel).toHaveBeenCalledWith("glm-4.7");
    spies.setModel.mockClear();
    ui.answerSelect(1);
    await runCommand(ctx, "/model", "");
    expect(spies.setModel).toHaveBeenCalledWith(suggestedModels(runtime.provider)[1]);
  });

  it("/permissions shows rules and adds session rules", async () => {
    await runCommand(ctx, "/permissions", "allow shell(git status*)");
    await runCommand(ctx, "/permissions", "deny shell(rm *)");
    expect(runtime.permissions.rules()).toEqual({ allow: ["shell(git status*)"], deny: ["shell(rm *)"] });
    await runCommand(ctx, "/permissions", "");
    expect(ui.text()).toContain("shell(git status*)");
  });

  it("/context and /cost report usage", async () => {
    await runCommand(ctx, "/context", "");
    expect(ui.text()).toMatch(/\d+%/);
    expect(ui.text()).toContain("tool output");
    await runCommand(ctx, "/cost", "");
    expect(ui.text()).toContain("Usage this session");
    expect(ui.text()).toContain("Model calls");
  });

  it("/clear resets the conversation and screen", async () => {
    runtime.engine.messages.push({ role: "user", content: "hi" });
    await runCommand(ctx, "/clear", "");
    expect(runtime.engine.messages).toHaveLength(1);
    expect(ui.cleared).toBe(1);
  });

  it("/export writes the conversation to a file in the project", async () => {
    runtime.engine.messages.push({ role: "user", content: "export me" }, { role: "assistant", content: "ok" });
    await runCommand(ctx, "/export", "notes/chat.md");
    const file = path.join(project, "notes", "chat.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("export me");
    expect(ui.text()).toContain("Saved the conversation to notes/chat.md");
  });

  it("/copy copies the last assistant message through the terminal when no native tool exists", async () => {
    runtime.engine.messages.push({ role: "assistant", content: "the answer" });
    await runCommand(ctx, "/copy", "");
    expect(ui.raw).toEqual(["<osc52:the answer>"]);
    expect(ui.text()).toContain("Copied 10 characters");
    ui.printed = [];
    runtime.engine.messages.length = 1;
    await runCommand(ctx, "/copy", "");
    expect(ui.text()).toContain("Nothing to copy yet");
  });

  it("/theme switches the palette and remembers it", async () => {
    await runCommand(ctx, "/theme", "light");
    expect(style.theme).toBe("light");
    expect(JSON.parse(readFileSync(path.join(process.env.REVCODE_HOME as string, "config.json"), "utf8"))).toMatchObject({ theme: "light" });
    await runCommand(ctx, "/theme", "dark");
    expect(style.theme).toBe("dark");
    await runCommand(ctx, "/theme", "neon");
    expect(ui.text()).toContain('Expected "auto", "dark" or "light"');
  });

  it("/config shows the settings in effect and the files they came from", async () => {
    ctx.configFiles = ["/home/u/.revcode/config.json"];
    ctx.configWarnings = ["bad key"];
    await runCommand(ctx, "/config", "");
    const out = ui.text();
    expect(out).toContain("Settings in effect");
    expect(out).toContain("Permission mode");
    expect(out).toContain("/home/u/.revcode/config.json");
    expect(out).toContain("bad key");
  });

  it("/vim toggles Vim editing and remembers the choice", async () => {
    await runCommand(ctx, "/vim", "");
    expect(ui.text()).toContain("Vim mode on");
    expect(JSON.parse(readFileSync(path.join(process.env.REVCODE_HOME as string, "config.json"), "utf8"))).toMatchObject({ vim: true });
  });

  it("/verbose toggles detailed output", async () => {
    await runCommand(ctx, "/verbose", "");
    expect(ctx.renderer.verbose).toBe(true);
    expect(ui.text()).toContain("Detailed tool output on");
  });

  it("/init and /review hand a prompt to the model", async () => {
    await runCommand(ctx, "/init", "");
    expect(spies.runPrompt).toHaveBeenLastCalledWith(expect.stringContaining("AGENTS.md"), "/init");
    await runCommand(ctx, "/review", "the auth changes");
    expect(spies.runPrompt).toHaveBeenLastCalledWith(expect.stringContaining("the auth changes"), "/review the auth changes");
    expect((spies.runPrompt.mock.calls.at(-1) as unknown as string[])[0]).toContain("git diff");
  });

  it("/resume lists sessions, loads one by prefix, and refuses universe sessions", async () => {
    const snapshot = (id: string, universeId?: string): SessionSnapshot => ({
      meta: { id, cwd: project, provider: "zai", model: "m", title: `title ${id}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", turns: 2, universeId },
      messages: [{ role: "system", content: "s" }, { role: "user", content: "hello" }],
    });
    saveSession(snapshot("20260101-aaaaaa"));
    saveSession(snapshot("20260102-bbbbbb", "u1-universe"));

    ui.answerSelect(1);
    await runCommand(ctx, "/resume", "");
    expect(ui.selects[0].options).toHaveLength(2);

    await runCommand(ctx, "/resume", "20260101");
    expect(spies.adoptSession).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ id: "20260101-aaaaaa" }) }));

    spies.adoptSession.mockClear();
    await runCommand(ctx, "/resume", "20260102-bbbbbb");
    expect(spies.adoptSession).not.toHaveBeenCalled();
    expect(ui.text()).toContain("Parallel Universe");
    await runCommand(ctx, "/resume", "missing-id");
    expect(ui.text()).toContain('No session "missing-id"');
  });

  it("/tools lists names and can dump JSON", async () => {
    await runCommand(ctx, "/tools", "");
    expect(ui.text()).toContain("read_file");
    ui.printed = [];
    await runCommand(ctx, "/tools", "json");
    expect(ui.text()).toContain('"name": "read_file"');
  });

  it("/doctor checks the environment", async () => {
    await runCommand(ctx, "/doctor", "");
    expect(ui.text()).toContain("Node.js");
    expect(ui.text()).toContain("terminal");
  });

  it("/mcp, /skills and /hooks explain how to configure when empty", async () => {
    await runCommand(ctx, "/mcp", "");
    await runCommand(ctx, "/skills", "");
    await runCommand(ctx, "/hooks", "");
    expect(ui.text()).toContain("No MCP servers configured");
    expect(ui.text()).toContain("No skills found");
    expect(ui.text()).toContain("No hooks configured");
  });

  it("/receipt reports when there is none", async () => {
    await runCommand(ctx, "/receipt", "");
    expect(ui.text()).toContain("No receipt yet");
  });
});
