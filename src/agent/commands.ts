/**
 * Built-in slash commands that do not depend on Parallel Universes.
 *
 * Each handler gets a `CommandContext` — a narrow view of the running agent — so the command
 * set can grow without the Agent class growing with it. Output goes through the renderer so it
 * lands in the transcript above the prompt like everything else.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CliArgs } from "../cli.js";
import { loadInstructions } from "../config/instructions.js";
import { saveUserConfig } from "../config/config.js";
import { copyToClipboard, osc52Sequence } from "../tui/clipboard.js";
import { formatDuration, formatTokens, plural } from "../tui/fmt.js";
import type { TerminalRenderer } from "../tui/render.js";
import { detectTheme, type Style, type TermCaps } from "../tui/style.js";
import { builtinNames, builtinSlashCommands, type SlashCommand } from "../tui/slash-commands.js";
import { truncate } from "../tui/width.js";
import { VERSION } from "../version.js";
import { estimateTokens } from "./context.js";
import { runDoctor } from "./doctor.js";
import { conversationToMarkdown } from "./export-md.js";
import { PERMISSION_MODES, type PermissionMode } from "./permissions.js";
import { listSessions, loadSession, type SessionSnapshot } from "./session.js";
import type { Runtime } from "./setup.js";
import type { Receipt } from "../universe/receipts.js";
import { formatReceipt } from "../universe/receipts.js";

export interface CommandContext {
  rt: Runtime;
  args: CliArgs;
  renderer: TerminalRenderer;
  style: Style;
  caps: TermCaps;
  startedAt: number;
  configFiles: string[];
  configWarnings: string[];
  slashCommands(): SlashCommand[];
  getModel(): string;
  setModel(model: string): void;
  getLastReceipt(): Receipt | undefined;
  /** Run a prompt through the model as if the user had typed it. */
  runPrompt(prompt: string, display: string): Promise<void>;
  adoptSession(snapshot: SessionSnapshot): void;
  refreshStatus(): void;
  /** Toggle Vim editing in the prompt; returns the new state. */
  toggleVim(): boolean;
}

/** Models worth suggesting for `/model`, by provider. */
export function suggestedModels(provider: string): string[] {
  switch (provider) {
    case "zai":
      return ["glm-5.2", "glm-4.7", "glm-4.7-flash"];
    case "anthropic":
      return ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];
    case "openai":
      return ["gpt-5", "gpt-4.1", "o3"];
    default:
      return [];
  }
}

const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: "prompt before edits and shell commands",
  "accept-edits": "edit files freely, still ask before shell commands",
  plan: "read-only: investigate and propose a plan",
  yolo: "never ask (use inside a Parallel Universe or a sandbox)",
};

const INIT_PROMPT = `Analyze this repository and create (or improve, if it exists) an AGENTS.md at the project root that will help future coding agents work here effectively.

Investigate first: the README, package/build manifests, CI config, the directory layout, and a few representative source and test files. Then write a concise AGENTS.md (aim for under 80 lines) covering only what is not obvious from reading the code:
- the exact commands to build, test (including running a single test) and lint
- the architecture in a few sentences and where the important code lives
- conventions and gotchas that a newcomer would get wrong
Do not pad it with generic advice. If AGENTS.md already exists, keep what is accurate and tighten the rest.`;

const REVIEW_PROMPT = `Review the uncommitted changes in this repository: run \`git status\` and \`git diff\` (include staged changes with \`git diff --cached\`). Read the surrounding code where the diff alone is not enough.
Report problems in order of importance: bugs and incorrect logic, risky or unsafe changes, missing error handling or tests, then style. Be specific — name the file and line and say what to change. If everything looks good, say so briefly. Do not modify any files.`;

function bar(style: Style, segments: Array<{ tokens: number; role: Parameters<Style["paint"]>[0] }>, limit: number, width = 40): string {
  const total = segments.reduce((sum, s) => sum + s.tokens, 0);
  let used = 0;
  let out = "";
  for (const segment of segments) {
    const cells = Math.min(width - used, Math.round((segment.tokens / limit) * width));
    if (cells > 0) out += style.paint(segment.role, "█".repeat(cells));
    used += Math.max(0, cells);
  }
  if (used === 0 && total > 0) {
    out += style.paint(segments[0].role, "▏");
    used = 1;
  }
  return `${out}${style.dim("░".repeat(Math.max(0, width - used)))}`;
}

const NO_SOURCES = { models: () => [], modes: () => [], sessions: () => [] };

export async function runCommand(ctx: CommandContext, name: string, arg: string): Promise<boolean> {
  const { rt, renderer, style } = ctx;
  const say = (text: string): void => renderer.info(text);

  switch (name) {
    case "/help":
      showHelp(ctx);
      return true;

    case "/status": {
      const instructions = loadInstructions(ctx.args.cwd).files;
      const mcp = rt.mcp?.statuses() ?? [];
      const connected = mcp.filter((s) => s.state === "connected").length;
      const usage = rt.engine.stats.usage;
      const pairs: Array<[string, string]> = [
        ["Version", `RevCode ${VERSION}`],
        ["Model", `${ctx.getModel()} (${rt.provider})`],
        ["Profile", rt.profileSource],
        ["Mode", `${rt.permissions.getMode()} — ${MODE_DESCRIPTIONS[rt.permissions.getMode()]}`],
        ["Directory", ctx.args.cwd],
        ["Session", `${rt.sessionId} · ${plural(rt.turn.value, "turn")} · ${formatDuration(Date.now() - ctx.startedAt)}`],
        ["Context", `~${formatTokens(rt.engine.estimatedTokens())} of ${formatTokens(rt.profile.contextLimit)} tokens (${Math.round((rt.engine.estimatedTokens() / rt.profile.contextLimit) * 100)}%)`],
        ["Usage", `${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out · ${plural(rt.engine.stats.apiCalls, "model call")}`],
      ];
      if (rt.universe) pairs.push(["Universe", `${rt.universe.id} (changes stay isolated until /land)`]);
      pairs.push(["Instructions", instructions.length > 0 ? instructions.join(", ") : "none (try /init)"]);
      pairs.push(["MCP", mcp.length === 0 ? "none" : `${connected}/${mcp.length} connected`]);
      pairs.push(["Skills", rt.skills.length === 0 ? "none" : `${rt.skills.length}`]);
      pairs.push(["Hooks", rt.hooks ? `${rt.hooks.summary().length} configured` : "none"]);
      pairs.push(["Terminal", `${ctx.caps.colorDepth === 24 ? "truecolor" : ctx.caps.colorDepth === 8 ? "256 colors" : ctx.caps.colorDepth === 4 ? "16 colors" : "no color"} · ${style.theme} theme`]);
      renderer.section("Status", renderer.keyValues(pairs));
      return true;
    }

    case "/model": {
      const options = suggestedModels(rt.provider);
      const current = ctx.getModel();
      if (arg) {
        try {
          ctx.setModel(arg);
          renderer.success(`Model switched to ${ctx.getModel()}.`);
        } catch (error) {
          renderer.error(error instanceof Error ? error.message : String(error));
        }
        return true;
      }
      if (renderer.ui.interactive && options.length > 0) {
        const list = options.includes(current) ? options : [current, ...options];
        const choice = await renderer.ui.select({
          title: [style.bold("Switch model"), style.dim(`  current: ${current}  ·  or type /model <name> for any model id`)],
          options: list.map((model) => ({ label: model, hint: model === current ? "current" : undefined })),
          initial: Math.max(0, list.indexOf(current)),
        });
        if (choice !== undefined && list[choice] !== current) {
          ctx.setModel(list[choice]);
          renderer.success(`Model switched to ${ctx.getModel()}.`);
        }
        return true;
      }
      const lines = [...new Set([current, ...options])].map((m) => `${m === current ? style.paint("ok", "●") : " "} ${m}`);
      renderer.section("Models", [...lines, "", style.dim("Switch with /model <name>")]);
      return true;
    }

    case "/mode": {
      const pick = async (value: string): Promise<void> => {
        if (!(PERMISSION_MODES as readonly string[]).includes(value)) {
          renderer.error(`Unknown mode "${value}". Expected: ${PERMISSION_MODES.join(", ")}.`);
          return;
        }
        rt.permissions.setMode(value as PermissionMode);
        ctx.refreshStatus();
        renderer.success(`Permission mode: ${value} — ${MODE_DESCRIPTIONS[value as PermissionMode]}`);
      };
      if (arg) {
        await pick(arg);
        return true;
      }
      if (renderer.ui.interactive) {
        const current = rt.permissions.getMode();
        const choice = await renderer.ui.select({
          title: [style.bold("Permission mode"), style.dim("  how much RevCode may do without asking")],
          options: PERMISSION_MODES.map((mode) => ({ label: mode, hint: `${MODE_DESCRIPTIONS[mode]}${mode === current ? "  (current)" : ""}` })),
          initial: PERMISSION_MODES.indexOf(current),
        });
        if (choice !== undefined && PERMISSION_MODES[choice] !== current) await pick(PERMISSION_MODES[choice]);
        return true;
      }
      say(`Permission mode: ${rt.permissions.getMode()}  (set with /mode ${PERMISSION_MODES.join(" | ")})`);
      return true;
    }

    case "/plan":
      rt.permissions.setMode(rt.permissions.getMode() === "plan" ? "ask" : "plan");
      ctx.refreshStatus();
      renderer.success(rt.permissions.getMode() === "plan" ? "Plan mode: read-only. Ask for a plan, then switch back with /plan." : "Left plan mode (ask).");
      return true;

    case "/clear":
      rt.engine.reset();
      renderer.ui.clearScreen();
      renderer.setContextPercent(0);
      renderer.dimInfo("Conversation cleared.");
      return true;

    case "/compact": {
      const result = rt.engine.compactNow();
      renderer.setContextPercent((rt.engine.estimatedTokens() / rt.profile.contextLimit) * 100);
      renderer.dimInfo(result.compacted ? `Compacted context (~${formatTokens(result.removedTokens)} tokens reclaimed).` : "Nothing to compact yet.");
      return true;
    }

    case "/context":
    case "/tokens": {
      const limit = rt.profile.contextLimit;
      const byRole = { system: 0, user: 0, assistant: 0, tool: 0 };
      for (const message of rt.engine.messages) byRole[message.role] += estimateTokens([message]);
      const used = byRole.system + byRole.user + byRole.assistant + byRole.tool;
      const percent = Math.round((used / limit) * 100);
      const meter = bar(
        style,
        [
          { tokens: byRole.system, role: "muted" },
          { tokens: byRole.user, role: "accent" },
          { tokens: byRole.assistant, role: "heading" },
          { tokens: byRole.tool, role: "warn" },
        ],
        limit,
      );
      const legend = (label: string, tokens: number, role: Parameters<Style["paint"]>[0]): string => `${style.paint(role, "█")} ${label.padEnd(10)} ${formatTokens(tokens).padStart(6)}`;
      renderer.section("Context", [
        `${meter}  ${percent}%`,
        style.dim(`~${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} estimated tokens`),
        "",
        legend("system", byRole.system, "muted"),
        legend("you", byRole.user, "accent"),
        legend("assistant", byRole.assistant, "heading"),
        legend("tool output", byRole.tool, "warn"),
        ...(percent >= 70 ? ["", style.paint("warn", "Getting full — /compact trims old tool output, /clear starts fresh.")] : []),
      ]);
      return true;
    }

    case "/cost":
    case "/usage": {
      const { usage } = rt.engine.stats;
      const cached = usage.cachedInputTokens ?? 0;
      const pairs: Array<[string, string]> = [
        ["Input", `${usage.inputTokens.toLocaleString("en-US")} tokens${cached > 0 ? ` (${cached.toLocaleString("en-US")} cached)` : ""}`],
        ["Output", `${usage.outputTokens.toLocaleString("en-US")} tokens`],
        ["Model calls", String(rt.engine.stats.apiCalls)],
        ["Tool calls", String(rt.engine.stats.toolCalls)],
        ["Turns", String(rt.turn.value)],
        ["Session time", formatDuration(Date.now() - ctx.startedAt)],
      ];
      renderer.section("Usage this session", renderer.keyValues(pairs));
      return true;
    }

    case "/sessions": {
      const sessions = listSessions({ cwd: ctx.args.cwd }).slice(0, 15);
      if (sessions.length === 0) {
        say("No saved sessions for this directory.");
        return true;
      }
      renderer.section("Sessions", [
        ...sessions.map((s) => `${style.dim(s.id)}  ${style.dim(s.updatedAt.slice(0, 16).replace("T", " "))}  ${truncate(s.title, 56)}`),
        "",
        style.dim("Resume one with /resume <id> or revcode -r <id>"),
      ]);
      return true;
    }

    case "/resume": {
      const sessions = listSessions({ cwd: ctx.args.cwd }).filter((s) => s.id !== rt.sessionId);
      let id = arg;
      if (!id) {
        if (sessions.length === 0) {
          say("No earlier sessions for this directory.");
          return true;
        }
        if (!renderer.ui.interactive) {
          say(sessions.slice(0, 15).map((s) => `${s.id}  ${s.title}`).join("\n"));
          return true;
        }
        const shown = sessions.slice(0, 9);
        const choice = await renderer.ui.select({
          title: [style.bold("Resume a session"), style.dim(`  ${plural(sessions.length, "session")} in this directory`)],
          options: shown.map((s) => ({ label: truncate(s.title, 52), hint: `${s.updatedAt.slice(5, 16).replace("T", " ")} · ${plural(s.turns, "turn")}` })),
        });
        if (choice === undefined) return true;
        id = shown[choice].id;
      }
      const match = sessions.find((s) => s.id === id) ?? sessions.find((s) => s.id.startsWith(id));
      const snapshot = loadSession(match?.id ?? id);
      if (!snapshot) {
        renderer.error(`No session "${id}". Try /sessions.`);
        return true;
      }
      if (snapshot.meta.universeId && snapshot.meta.universeId !== rt.universe?.id) {
        renderer.warn(`That session ran inside Parallel Universe ${snapshot.meta.universeId}. Resume it with: revcode -r ${snapshot.meta.id}`);
        return true;
      }
      ctx.adoptSession(snapshot);
      return true;
    }

    case "/init":
      await ctx.runPrompt(INIT_PROMPT, "/init");
      return true;

    case "/review":
      await ctx.runPrompt(arg ? `${REVIEW_PROMPT}\n\nPay particular attention to: ${arg}` : REVIEW_PROMPT, arg ? `/review ${arg}` : "/review");
      return true;

    case "/copy": {
      let text = renderer.getLastAssistantText();
      if (!text) text = [...rt.engine.messages].reverse().find((m) => m.role === "assistant" && (m.content ?? "").trim())?.content ?? "";
      if (!text.trim()) {
        say("Nothing to copy yet.");
        return true;
      }
      const method = await copyToClipboard(text);
      if (method === "osc52") renderer.ui.rawWrite(osc52Sequence(text));
      renderer.success(`Copied ${text.length.toLocaleString("en-US")} characters${method === "osc52" ? " via the terminal (if your terminal allows it)" : ""}.`);
      return true;
    }

    case "/export": {
      const file = path.resolve(ctx.args.cwd, arg || `revcode-${rt.sessionId}.md`);
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, conversationToMarkdown(rt.engine.messages, { sessionId: rt.sessionId, model: ctx.getModel(), provider: rt.provider, cwd: ctx.args.cwd, exportedAt: new Date() }), "utf8");
        renderer.success(`Saved the conversation to ${path.relative(ctx.args.cwd, file) || file}.`);
      } catch (error) {
        renderer.error(`Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    }

    case "/verbose": {
      const on = renderer.toggleVerbose();
      renderer.dimInfo(`Detailed tool output ${on ? "on" : "off"} (Ctrl+O toggles).`);
      return true;
    }

    case "/vim": {
      const on = ctx.toggleVim();
      try {
        saveUserConfig({ vim: on });
      } catch {
        // not persisting is fine
      }
      renderer.success(on ? "Vim mode on — Esc for normal mode, i/a/o to insert. /vim turns it off." : "Vim mode off.");
      return true;
    }

    case "/theme": {
      const value = arg.toLowerCase();
      if (!value) {
        say(`Theme: ${style.theme}. Set with /theme auto | dark | light.`);
        return true;
      }
      if (value !== "auto" && value !== "dark" && value !== "light") {
        renderer.error('Expected "auto", "dark" or "light".');
        return true;
      }
      style.setTheme(value === "auto" ? detectTheme(process.env) : value);
      try {
        saveUserConfig({ theme: value });
      } catch {
        // not persisting is fine
      }
      renderer.ui.refresh();
      renderer.success(`Theme: ${value === "auto" ? `auto (${style.theme})` : value}.`);
      return true;
    }

    case "/config": {
      const a = ctx.args;
      const pairs: Array<[string, string]> = [
        ["Provider", `${rt.provider}${a.baseUrl ? ` (${a.baseUrl})` : ""}`],
        ["Model", ctx.getModel()],
        ["Permission mode", rt.permissions.getMode()],
        ["Profile", a.profile ?? "auto"],
        ["Theme", `${a.theme ?? "auto"} (showing ${style.theme})`],
        ["Vim mode", a.vim ? "on" : "off"],
        ["Universe by default", a.universe ? "yes" : "no"],
        ["Max tool iterations", String(a.maxIterations)],
        ["MCP / hooks / instructions", `${a.mcp === false ? "off" : "on"} / ${a.hooks === false ? "off" : "on"} / ${a.instructions === false ? "off" : "on"}`],
      ];
      renderer.section("Settings in effect", renderer.keyValues(pairs));
      renderer.section("Config files", [
        ...(ctx.configFiles.length === 0 ? [style.dim("none found — defaults and flags only")] : ctx.configFiles.map((f) => `${style.paint("ok", style.glyphs.check)} ${f}`)),
        ...ctx.configWarnings.map((w) => `${style.paint("warn", style.glyphs.warn)} ${w}`),
        "",
        style.dim("Order (later wins): ~/.revcode/config.json < .revcode/config.json < .revcode/config.local.json < command-line flags."),
      ]);
      return true;
    }

    case "/permissions": {
      const [action, ...ruleParts] = arg.split(/\s+/).filter(Boolean);
      const rule = ruleParts.join(" ");
      if ((action === "allow" || action === "deny") && rule) {
        if (action === "allow") rt.permissions.addAllowRule(rule);
        else rt.permissions.addDenyRule(rule);
        renderer.success(`Added ${action} rule "${rule}" for this session.`);
        return true;
      }
      const rules = rt.permissions.rules();
      renderer.section("Permissions", [
        ...renderer.keyValues([["Mode", `${rt.permissions.getMode()} — ${MODE_DESCRIPTIONS[rt.permissions.getMode()]}`]]),
        "",
        `${style.bold("Allow")} ${rules.allow.length === 0 ? style.dim("(none)") : ""}`,
        ...rules.allow.map((r) => `  ${r}`),
        `${style.bold("Deny")} ${rules.deny.length === 0 ? style.dim("(none)") : ""}`,
        ...rules.deny.map((r) => `  ${r}`),
        "",
        style.dim('Add for this session: /permissions allow "shell(git status*)". Persist rules in .revcode/config.json.'),
      ]);
      return true;
    }

    case "/mcp": {
      const statuses = rt.mcp?.statuses() ?? [];
      if (statuses.length === 0) {
        say("No MCP servers configured. Add them to .mcp.json or .revcode/mcp.json.");
        return true;
      }
      renderer.section(
        "MCP servers",
        statuses.map((s) => {
          const mark = s.state === "connected" ? style.paint("ok", style.glyphs.bullet) : style.paint("error", style.glyphs.cross);
          const detail = s.state === "connected" ? `${plural(s.toolCount, "tool")} · ${s.transport}` : `${s.state}${s.error ? `: ${truncate(s.error.split("\n")[0], 70)}` : ""}`;
          return `${mark} ${s.name}  ${style.dim(detail)}`;
        }),
      );
      return true;
    }

    case "/skills": {
      if (rt.skills.length === 0) {
        say("No skills found. Add SKILL.md files under .revcode/skills, .claude/skills or .agents/skills.");
        return true;
      }
      renderer.section(
        "Skills",
        rt.skills.map((skill) => `${style.paint("accent", skill.name)}  ${style.dim(truncate(skill.description, 80))}`),
      );
      return true;
    }

    case "/hooks": {
      const hooks = rt.hooks?.summary() ?? [];
      if (hooks.length === 0) {
        say("No hooks configured. Add them to .revcode/hooks.json (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart).");
        return true;
      }
      renderer.section("Hooks", hooks.map((h) => `${style.bold(h.event)} ${style.dim(`[${h.matcher}]`)}  ${truncate(h.command, 70)}`));
      return true;
    }

    case "/memory": {
      const { files } = loadInstructions(ctx.args.cwd);
      renderer.section("Project instructions", [
        ...(files.length === 0 ? [style.dim("No AGENTS.md or CLAUDE.md found.")] : files.map((f) => `${style.paint("ok", style.glyphs.check)} ${f}`)),
        "",
        style.dim("These are loaded into every session. /init creates or improves AGENTS.md."),
      ]);
      return true;
    }

    case "/tools": {
      const defs = rt.tools.definitions();
      if (arg === "json") {
        renderer.dimInfo(JSON.stringify(defs, null, 2));
        return true;
      }
      renderer.section(
        `Tools (${defs.length})`,
        defs.map((d) => `${style.paint("accent", d.name.padEnd(18))} ${style.dim(truncate((d.description ?? "").split(/(?<=[.!?])\s/)[0], 80))}`),
      );
      return true;
    }

    case "/profile":
      renderer.section("Harness profile", [style.dim(`source: ${rt.profileSource}`), ...JSON.stringify(rt.profile, null, 2).split("\n")]);
      return true;

    case "/doctor": {
      const instructions = loadInstructions(ctx.args.cwd).files;
      const checks = await runDoctor({
        provider: rt.provider,
        model: ctx.getModel(),
        caps: ctx.caps,
        columns: renderer.ui.columns,
        rows: process.stdout.rows ?? 24,
        configFiles: ctx.configFiles,
        configWarnings: ctx.configWarnings,
        mcp: (rt.mcp?.statuses() ?? []).map((s) => ({ name: s.name, state: s.state, error: s.error })),
        hookCount: rt.hooks?.summary().length ?? 0,
        instructionFiles: instructions,
      });
      const rows: string[] = [];
      for (const check of checks) {
        const mark = check.status === "ok" ? style.paint("ok", style.glyphs.check) : check.status === "warn" ? style.paint("warn", style.glyphs.warn) : style.paint("error", style.glyphs.cross);
        rows.push(`${mark} ${check.label}${check.detail ? `  ${style.dim(check.detail)}` : ""}`);
        if (check.hint) rows.push(`  ${style.dim(`→ ${check.hint}`)}`);
      }
      const problems = checks.filter((c) => c.status === "fail").length;
      rows.push("", problems > 0 ? style.paint("error", `${plural(problems, "problem")} found.`) : style.paint("ok", "Everything looks good."));
      renderer.section("Doctor", rows);
      return true;
    }

    case "/receipt": {
      const receipt = ctx.getLastReceipt();
      if (!receipt) {
        say("No receipt yet — run a task first.");
        return true;
      }
      const lines = [...formatReceipt(receipt), ""];
      for (const c of receipt.commands.slice(-12)) lines.push(`  $ ${c.command}  → exit ${c.exitCode ?? "?"}${c.timedOut ? " (timed out)" : ""}`);
      for (const f of receipt.files.slice(0, 20)) lines.push(`  ${f.status} ${f.path}${f.insertions || f.deletions ? `  (+${f.insertions} ${style.glyphs.minus}${f.deletions})` : ""}`);
      say(lines.join("\n"));
      return true;
    }

    case "/messages":
      renderer.dimInfo(JSON.stringify(rt.engine.messages, null, 2));
      return true;

    default:
      return false;
  }
}

function showHelp(ctx: CommandContext): void {
  const { renderer, style, rt } = ctx;
  const everything = ctx.slashCommands();
  const customNames = new Set(rt.commands.map((c) => `/${c.name}`));
  const all = everything.filter((c) => !customNames.has(c.command) || builtinNames(builtinSlashCommands(NO_SOURCES)).has(c.command));
  const builtins = builtinNames(all);
  const custom = rt.commands.filter((c) => !builtins.has(`/${c.name}`));
  const width = Math.max(...all.map((c) => `${c.command}${c.args ? ` ${c.args}` : ""}`.length), 12) + 2;
  const universeOnly = (c: SlashCommand): boolean => c.description.startsWith("Universe:");

  const commandRows = (list: SlashCommand[]): string[] =>
    list.map((c) => {
      const left = `${c.command}${c.args ? ` ${c.args}` : ""}`;
      return `${style.paint("accent", left)}${" ".repeat(Math.max(2, width - left.length))}${style.dim(c.description)}`;
    });

  renderer.section("Commands", commandRows(all.filter((c) => !universeOnly(c))));
  renderer.section(
    rt.universe ? "Parallel Universe" : "Parallel Universe (start with revcode --universe)",
    commandRows(all.filter(universeOnly)),
  );
  if (custom.length > 0) {
    renderer.section(
      "Custom commands & skills",
      custom.map((c) => `${style.paint("accent", `/${c.name}`)}${c.argumentHint ? ` ${style.dim(c.argumentHint)}` : ""}  ${style.dim(truncate(c.description, 70))}`),
    );
  }
  const keys: Array<[string, string]> = [
    ["Enter", "send"],
    ["Shift+Enter · Ctrl+J · \\ Enter", "new line"],
    ["Esc", "interrupt a running task · clear the prompt"],
    ["Ctrl+C", "clear the prompt · press twice to quit"],
    ["↑ ↓ · Ctrl+R", "prompt history · search it"],
    ["Tab", "accept a / or @ suggestion"],
    ["Shift+Tab", "cycle permission mode"],
    ["Ctrl+O", "show more tool output"],
    ["Ctrl+W · Ctrl+U · Ctrl+K · Ctrl+Y", "delete word · to line start · to line end · paste it back"],
    ["Alt+← → · Ctrl+_", "move by word · undo"],
    ["/vim", "Vim-style editing in the prompt"],
    ["Ctrl+L · Ctrl+Z", "clear screen · suspend"],
    ["@path", "attach a file"],
    ["!command", "run a shell command yourself"],
  ];
  renderer.section("Keyboard", renderer.keyValues(keys));
}
