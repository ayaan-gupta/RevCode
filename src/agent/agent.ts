/**
 * Agent — the terminal shell around the engine.
 *
 * Owns the process-level concerns: parsing slash commands, reading input,
 * rendering, approvals, Ctrl-C, session saving, and the headless output formats.
 * Everything about *how the model works* lives in the engine and runtime setup,
 * so the same logic also drives subagents, Dyno benchmarks, and replays.
 */

import { stdin as input } from "node:process";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CliArgs } from "../cli.js";
import { loadConfig } from "../config/config.js";
import { loadInstructions } from "../config/instructions.js";
import { resolveProvider, type LlmToolCall } from "../llm/client.js";
import { formatUsd } from "../llm/pricing.js";
import { setRetryListener } from "../llm/retry.js";
import { setShellOutputListener } from "../tools/shell-session.js";
import { DEFAULT_PROFILE } from "../harness/profile.js";
import { buildSystemPrompt as buildPrompt } from "../harness/prompt.js";
import { expandCommand, findCommand, parseSlashInput } from "../skills/index.js";
import { confirmYesNo, createTerminalApprover } from "../tui/approval.js";
import { createCompleter, FileIndex, rankByFuzzy } from "../tui/completion.js";
import { LineEditor } from "../tui/editor.js";
import { formatDuration, formatTokens, plural, sanitizeForDisplay } from "../tui/fmt.js";
import { HistoryStore, historyFileFor } from "../tui/history.js";
import { explainError } from "../tui/errors.js";
import { expandMentions, pastedPathToMention } from "../tui/mentions.js";
import { TerminalRenderer } from "../tui/render.js";
import { renderDiffView } from "../tui/diff-view.js";
import { builtinSlashCommands, type SlashCommand } from "../tui/slash-commands.js";
import { detectCaps, Style, type TermCaps } from "../tui/style.js";
import { activityLabel } from "../tui/tool-view.js";
import { PlainUI, TerminalUI, type Ui } from "../tui/ui.js";
import { truncateToConsistent } from "../universe/recorder.js";
import type { Receipt } from "../universe/receipts.js";
import {
  describeUniverse,
  formatCheckpoints,
  formatChangeSummary,
  formatUniverseList,
  landFlow,
  landOutcome,
} from "../universe/ui.js";
import { formatLandIf, landIfPasses, type LandIfOutcome } from "../universe/land-if.js";
import { Universe } from "../universe/universe.js";
import { VERSION } from "../version.js";
import { runCommand, suggestedModels, type CommandContext } from "./commands.js";
import { estimateTokens } from "./context.js";
import { segmentToolCalls, type EngineObserver, type TrajectoryEvent, type TurnResult } from "./engine.js";
import { PERMISSION_MODES, type PermissionMode } from "./permissions.js";
import {
  deriveTitle,
  latestSession,
  listSessions,
  loadSession,
  saveSession,
  type SessionSnapshot,
} from "./session.js";
import { createRuntime, type Runtime } from "./setup.js";
import { runTrackedTurn } from "./turn.js";

const SUGGESTED_GLM_MODELS = ["glm-5.2", "glm-4.7", "glm-4.7-flash"] as const;

export interface AgentRunResult {
  finalContent: string;
  turn: TurnResult;
  trajectory: TrajectoryEvent[];
  universeId?: string;
}

/** Legacy helper kept for callers that only need the default prompt for a directory. */
export function buildSystemPrompt(args: Pick<CliArgs, "cwd">): string {
  return buildPrompt({ cwd: args.cwd, profile: DEFAULT_PROFILE });
}

const UNIVERSE_COMMANDS = new Set(["/diff", "/land", "/checkpoints", "/rewind", "/fork", "/universes", "/discard"]);

export class Agent {
  private args: CliArgs;
  private readonly interactive: boolean;
  private currentModel: string;
  private runtime?: Runtime;
  private readonly caps: TermCaps;
  private readonly style: Style;
  private readonly ui: Ui;
  private readonly renderer: TerminalRenderer;
  private readonly files: FileIndex | undefined;
  private readonly editor: LineEditor | undefined;
  private turnAbort?: AbortController;
  private lastSigint = 0;
  private lastReceipt?: Receipt;
  private resumed?: SessionSnapshot;
  private sessionCreatedAt = new Date().toISOString();
  private readonly startedAt = Date.now();
  private disposed = false;
  /** Text the model should see with the next prompt (e.g. the output of a `!command`). */
  private pendingContext: string[] = [];
  private initialMode: PermissionMode = "ask";

  constructor(args: CliArgs) {
    this.args = args;
    this.interactive = !args.headless;
    this.currentModel = args.model;

    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.TERM !== "dumb";
    this.caps = detectCaps(process.env, Boolean(process.stdout.isTTY), args.theme === "auto" ? undefined : args.theme);
    this.style = new Style(this.caps);

    if (this.interactive && tty && process.env.REVCODE_PLAIN_UI !== "1") {
      const history = new HistoryStore(historyFileFor(args.cwd));
      this.files = new FileIndex(args.cwd);
      void this.files.load();
      const editor = new LineEditor({
        history: history.entries(),
        completer: createCompleter({ commands: () => this.slashCommands(), files: this.files }),
        transformPaste: (text) => pastedPathToMention(text, this.args.cwd),
      });
      editor.setVim(args.vim === true);
      this.editor = editor;
      this.ui = new TerminalUI({
        stdin: process.stdin,
        stdout: process.stdout,
        style: this.style,
        editor,
        history,
        status: () => this.renderer.statusModel(),
        hooks: {
          onInterrupt: () => this.interruptTurn(),
          onForceExit: () => {
            this.dispose();
            process.exit(130);
          },
          onCycleMode: () => this.cycleMode(),
          onToggleVerbose: () => {
            const on = this.renderer.toggleVerbose();
            this.ui.hint(on ? "Detailed tool output on" : "Detailed tool output off");
          },
        },
        title: `revcode · ${path.basename(args.cwd) || args.cwd}`,
      });
    } else {
      this.ui = new PlainUI({ stdin: process.stdin, stdout: process.stdout, columns: process.stdout.columns });
    }
    this.renderer = new TerminalRenderer(args.cwd, args.model, this.ui, this.style, { verbose: args.verbose });
    if (this.interactive) {
      setShellOutputListener((chunk) => this.renderer.toolOutputChunk(chunk));
      setRetryListener((notice) =>
        this.ui.setNote(`${notice.reason} ${this.style.glyphs.dot} retrying in ${formatDuration(notice.delayMs)} (attempt ${notice.attempt + 1}/${notice.maxAttempts})`, notice.delayMs + 2000),
      );
    }
    this.registerShutdownHandlers();
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Release the persistent shell, MCP servers, and anything else the runtime
   * owns. Safe from signal handlers and `exit`: the shell teardown is synchronous.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    setRetryListener(undefined);
    setShellOutputListener(undefined);
    this.ui.unmount();
    void this.runtime?.dispose();
  }

  private registerShutdownHandlers(): void {
    process.once("exit", () => this.dispose());
    for (const signal of ["SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        this.dispose();
        process.exit(143);
      });
    }
    process.on("SIGINT", () => {
      // Raw-mode Ctrl+C never raises SIGINT; this is for `kill -INT` and non-TTY sessions.
      const now = Date.now();
      if (this.turnAbort && !this.turnAbort.signal.aborted && now - this.lastSigint > 3000) {
        this.lastSigint = now;
        this.interruptTurn();
        this.renderer.dimInfo("Interrupted. Send SIGINT again within 3s to quit.");
        return;
      }
      this.dispose();
      process.exit(130);
    });
  }

  async start(): Promise<void> {
    try {
      if (this.args.headless) {
        await this.runHeadless();
        return;
      }
      await this.runInteractive();
    } finally {
      this.dispose();
    }
  }

  setModel(model: string): void {
    const trimmed = model.trim();
    if (!trimmed) {
      throw new Error("Model name cannot be empty");
    }
    if (this.runtime) {
      const switched = this.runtime.switchModel(trimmed);
      this.renderer.dimInfo(`Profile: ${switched.profileSource}`);
    }
    this.currentModel = trimmed;
    this.args = { ...this.args, model: trimmed };
    this.renderer.updateModel(trimmed);
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  /** Run a single task to completion (used by headless mode and programmatic callers). */
  async runTask(instruction: string): Promise<AgentRunResult> {
    const runtime = await this.ensureRuntime(instruction);
    const turn = await runtime.engine.runTurn(instruction, this.turnAbort?.signal);
    return { finalContent: turn.finalContent, turn, trajectory: [...runtime.engine.trajectory], universeId: runtime.universe?.id };
  }

  private interruptTurn(): void {
    this.turnAbort?.abort();
    this.runtime?.tools.interruptShell();
  }

  private cycleMode(): void {
    const rt = this.runtime;
    if (!rt) return;
    const order: PermissionMode[] = this.initialMode === "yolo" ? ["yolo", "ask", "accept-edits", "plan"] : ["ask", "accept-edits", "plan"];
    const current = rt.permissions.getMode();
    const next = order[(order.indexOf(current) + 1) % order.length] ?? "ask";
    rt.permissions.setMode(next);
    this.refreshStatus();
    this.ui.hint(`Mode: ${next === "yolo" && rt.universe ? "private copy" : next}`);
  }

  // --- runtime ----------------------------------------------------------------

  private async ensureRuntime(task?: string): Promise<Runtime> {
    if (this.runtime) {
      return this.runtime;
    }
    const observer = this.interactive ? this.interactiveObserver() : this.headlessObserver();
    const approver = this.interactive && this.ui.interactive ? createTerminalApprover({ renderer: this.renderer, cwd: () => this.runtime?.cwd ?? this.args.cwd, onCancel: () => this.interruptTurn() }) : undefined;
    const warn = (message: string): void => {
      if (this.interactive) this.renderer.warn(message);
      else process.stderr.write(`[revcode] ${message}\n`);
    };

    let universe: Universe | undefined;
    if (this.resumed?.meta.universeId) {
      try {
        universe = Universe.open(this.resumed.meta.universeId);
        if (universe.meta.status === "discarded") universe = undefined;
      } catch {
        warn(`The private copy from that session (${this.resumed.meta.universeId}) no longer exists.`);
      }
    }

    this.runtime = await createRuntime({
      args: { ...this.args, model: this.currentModel },
      interactive: this.interactive,
      observer,
      approver,
      warn,
      confirm:
        this.interactive && this.ui.interactive
          ? (question) => {
              const [first, ...detail] = question.split("\n");
              return confirmYesNo(this.renderer, first, detail);
            }
          : undefined,
      sessionId: this.resumed?.meta.id,
      initialMessages: this.resumed?.messages,
      universe,
      autoUniverse: this.interactive,
      task,
    });
    this.initialMode = this.runtime.permissions.getMode();
    this.renderer.setModeSource(() => this.displayMode());
    this.refreshStatus();
    return this.runtime;
  }

  private refreshStatus(): void {
    const rt = this.runtime;
    if (!rt) return;
    this.renderer.setExtras([]);
    this.renderer.setMode(this.displayMode());
  }

  /** The permission mode as the status bar shows it: no-prompt mode in a universe is the private copy. */
  private displayMode(): string {
    const mode = this.runtime?.permissions.getMode() ?? "ask";
    return mode === "yolo" && this.runtime?.universe ? "copy" : mode;
  }

  /** Built-in plus custom commands, as the prompt's completion menu and /help see them. */
  private slashCommands(): SlashCommand[] {
    const rt = this.runtime;
    const builtins = builtinSlashCommands({
      models: () => suggestedModels(rt?.provider ?? "zai"),
      modes: () => [...PERMISSION_MODES],
      sessions: () =>
        listSessions({ cwd: this.args.cwd })
          .slice(0, 12)
          .map((s) => s.id),
    });
    const taken = new Set(builtins.map((c) => c.command));
    const custom = (rt?.commands ?? [])
      .filter((c) => !taken.has(`/${c.name}`))
      .map((c) => ({ command: `/${c.name}`, description: c.description, ...(c.argumentHint ? { args: c.argumentHint } : {}) }));
    return [...builtins, ...custom];
  }

  // --- headless ---------------------------------------------------------------

  private async runHeadless(): Promise<void> {
    const instruction = await this.resolveHeadlessInstruction();
    this.turnAbort = new AbortController();
    const runtime = await this.ensureRuntime(instruction);

    let context = "";
    if (runtime.hooks) {
      const prompt = await runtime.hooks.runUserPromptSubmit(instruction);
      if (prompt.blocked) {
        process.stderr.write(`[revcode] prompt blocked by hook: ${prompt.blocked}\n`);
        process.exitCode = 1;
        return;
      }
      context = prompt.context ? `\n\n${prompt.context}` : "";
    }
    const startContext = runtime.sessionStartContext ? `\n\n${runtime.sessionStartContext}` : "";
    const expanded = expandMentions(instruction, runtime.cwd).text;

    const { result: turn } = await runTrackedTurn(runtime, `${expanded}${startContext}${context}`, {
      signal: this.turnAbort.signal,
      recordedPrompt: instruction,
    });

    await this.writeTrajectory();

    const landIf = this.args.landIf && runtime.universe ? await this.landIfPasses(runtime.universe, this.args.landIf, turn.stopReason) : undefined;

    const summary = {
      result: turn.finalContent,
      stopReason: turn.stopReason,
      iterations: turn.iterations,
      toolCalls: turn.toolCalls,
      toolErrors: turn.toolErrors,
      durationMs: turn.durationMs,
      usage: turn.usage,
      ...(runtime.price || runtime.spend.spentUsd > 0 ? { costUsd: Number(runtime.spend.spentUsd.toFixed(6)) } : {}),
      model: this.currentModel,
      profile: runtime.profileSource,
      universe: runtime.universe?.id,
      ...(landIf
        ? {
            landIf: {
              status: landIf.status,
              landed: landIf.status === "landed",
              files: landIf.files,
              ...(landIf.conflicts.length ? { conflicts: landIf.conflicts } : {}),
              ...(landIf.check ? { check: { command: landIf.check.command, passed: landIf.check.passed, exitCode: landIf.check.exitCode, timedOut: landIf.check.timedOut, durationMs: landIf.check.durationMs, tail: landIf.check.tail } } : {}),
              ...(landIf.reason ? { reason: landIf.reason } : {}),
            },
          }
        : {}),
      ...(turn.error ? { error: turn.error } : {}),
    };
    if (this.args.outputFormat === "json" || this.args.outputFormat === "stream-json") {
      console.log(JSON.stringify(this.args.outputFormat === "stream-json" ? { type: "result", ...summary } : summary));
    } else if (landIf && runtime.universe) {
      console.log(`\n${formatLandIf(landIf, runtime.universe, this.args.cwd).join("\n")}`);
    } else if (runtime.universe) {
      const stat = await runtime.universe.diffStat();
      console.log(`\nUniverse ${runtime.universe.id}: ${stat.files} file(s) changed (+${stat.insertions} −${stat.deletions}). Land with: revcode universes land ${runtime.universe.id}`);
    }
    if (turn.stopReason === "error") {
      process.stderr.write(`[revcode] ${turn.error ?? "model request failed"}\n`);
      process.exitCode = 1;
    }
    if (landIf && landIf.status !== "landed" && landIf.status !== "nothing-to-land") {
      process.exitCode = 1;
    }
  }

  private landIfPasses(universe: Universe, command: string, stopReason: string): Promise<LandIfOutcome> {
    if (this.args.outputFormat !== "json") process.stderr.write(`[revcode] checking: ${command}\n`);
    return landIfPasses(universe, command, { stopReason, signal: this.turnAbort?.signal });
  }

  private headlessObserver(): EngineObserver {
    const json = this.args.outputFormat === "json";
    const stream = this.args.outputFormat === "stream-json";
    const out = (line: string): void => (json ? void process.stderr.write(`${line}\n`) : void console.log(line));
    return {
      toolCall: (call: LlmToolCall) => {
        if (stream) console.log(JSON.stringify({ type: "tool_call", name: call.name, arguments: call.arguments, id: call.id }));
        else out(`[${call.name}(${JSON.stringify(call.arguments)})]`);
      },
      toolResult: (call, result) => {
        if (stream) console.log(JSON.stringify({ type: "tool_result", name: call.name, id: call.id, result }));
      },
      llmEnd: ({ content }) => {
        if (!content) return;
        if (stream) console.log(JSON.stringify({ type: "assistant", content }));
        else out(`\n${content}\n`);
      },
      notice: (message) => process.stderr.write(`[revcode] ${message}\n`),
    };
  }

  // --- interactive ------------------------------------------------------------

  private interactiveObserver(): EngineObserver {
    const started = new Map<string, { at: number; modal: number }>();
    return {
      textDelta: (text) => this.renderer.streamDelta(text),
      reasoningDelta: (text) => this.renderer.reasoningDelta(text),
      llmEnd: ({ content, streamed }) => {
        this.renderer.clearThought();
        if (this.renderer.isStreaming()) {
          this.renderer.streamEnd();
        } else if (content && !streamed) {
          this.renderer.assistant(content);
        }
      },
      toolCall: (call) => {
        this.renderer.streamEnd();
        this.renderer.clearThought();
        started.set(call.id, { at: Date.now(), modal: this.ui.modalMs() });
        this.ui.beginTool(call.id, activityLabel(call));
      },
      toolResult: (call, result) => {
        this.ui.endTool(call.id);
        // Time spent waiting for the user to answer a permission prompt is not the tool's time.
        const begun = started.get(call.id);
        const duration = begun ? Date.now() - begun.at - (this.ui.modalMs() - begun.modal) : 0;
        started.delete(call.id);
        if (call.name === "update_plan" && isPlanResult(result)) {
          this.renderer.plan(result.steps);
        } else {
          this.renderer.toolCard(call, result, duration);
        }
      },
      compaction: (removed) => this.renderer.dimInfo(`Compacted context (~${formatTokens(removed)} tokens reclaimed).`),
      notice: (message) => this.renderer.dimInfo(message),
    };
  }

  private async runInteractive(): Promise<void> {
    if (this.args.resume !== undefined) {
      this.loadResume();
    }
    this.renderer.welcome({
      version: VERSION,
      model: this.currentModel,
      provider: resolveProvider(this.args.provider, this.currentModel),
      cwd: this.args.cwd,
    });
    this.ui.mount();

    this.ui.setBusy(true, this.args.universe === false ? "Starting…" : "Copying your project…");
    let runtime: Runtime;
    try {
      runtime = await this.ensureRuntime();
    } finally {
      this.ui.setBusy(false);
    }
    this.showSessionInfo(runtime);

    while (true) {
      const next = await this.ui.nextInput();
      if (next.type === "eof" || shouldExit(next.text)) {
        if (await this.offerLandBeforeExit()) continue;
        break;
      }
      await this.handleInput(next.text, next.display);
    }

    this.ui.unmount();
    await this.exitSummary();
  }

  private showSessionInfo(runtime: Runtime): void {
    const parts: string[] = [];
    const instructions = this.args.instructions === false ? [] : loadInstructions(this.args.cwd).files;
    if (instructions.length > 0) parts.push(instructions.map((f) => path.basename(f)).filter((v, i, all) => all.indexOf(v) === i).join(" + "));
    const mcp = (runtime.mcp?.statuses() ?? []).filter((s) => s.state === "connected").length;
    if (mcp > 0) parts.push(`${mcp} MCP`);
    if (runtime.skills.length > 0) parts.push(plural(runtime.skills.length, "skill"));
    if (runtime.profileSource !== "default") parts.push(`${runtime.profileSource} profile`);
    if (parts.length > 0) this.renderer.dimInfo(`Loaded: ${parts.join(" · ")}`);
    if (instructions.length === 0 && !this.resumed && listSessions({ cwd: this.args.cwd }).length === 0) {
      this.renderer.dimInfo("New here? /init writes an AGENTS.md so RevCode knows this project's build and test commands.");
    }
    if (runtime.universe) {
      const mark = this.style.paint("accent", this.style.unicode ? "⌬" : "#");
      this.renderer.info(`${mark} Working in a private copy of this project. Your files change only when you ${this.style.paint("accent", "/land")}.`);
    } else if (runtime.universeSkipped) {
      this.renderer.dimInfo(`Working in this folder directly (${runtime.universeSkipped}), so RevCode asks before changing files.`);
    }
    if (this.resumed) {
      this.renderer.success(`Resumed session ${this.resumed.meta.id} (${this.resumed.meta.title}).`);
    }
  }

  private loadResume(): void {
    const wanted = this.args.resume ?? "";
    const id = wanted || latestSession(this.args.cwd)?.id;
    const snapshot = id ? loadSession(id) : undefined;
    if (!snapshot) {
      this.renderer.dimInfo(id ? `Session ${id} not found; starting fresh.` : "No previous session in this directory; starting fresh.");
      return;
    }
    this.resumed = snapshot;
    this.sessionCreatedAt = snapshot.meta.createdAt;
    if (!this.args.explicit?.includes("model") && snapshot.meta.model) {
      this.currentModel = snapshot.meta.model;
    }
  }

  /** Route one submitted line: shell mode, slash command, or a prompt for the model. */
  private async handleInput(text: string, display: string): Promise<void> {
    const trimmed = text.trim();
    this.renderer.echoUser(display);
    try {
      if (trimmed.startsWith("!") && trimmed.length > 1) {
        await this.runUserShell(trimmed.slice(1).trim());
        return;
      }
      if (trimmed.startsWith("/") && (await this.handleSlashCommand(trimmed))) {
        return;
      }
      await this.interactiveTurn(text, display);
    } catch (error) {
      this.renderer.error(error instanceof Error ? error.message : String(error));
    }
  }

  /** `!command`: the user runs a shell command directly; the model hears about it next turn. */
  private async runUserShell(command: string): Promise<void> {
    if (!command) return;
    const rt = await this.ensureRuntime();
    const call = { name: "shell", arguments: { command } };
    const started = Date.now();
    const id = `user-shell-${started}`;
    this.ui.setBusy(true);
    this.ui.beginTool(id, activityLabel(call));
    let result: unknown;
    try {
      result = await rt.tools.execute("shell", { command });
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.ui.endTool(id);
      this.ui.setBusy(false);
    }
    this.renderer.toolCard(call, result, Date.now() - started);
    const record = (result ?? {}) as { stdout?: string; exitCode?: number; error?: string };
    const output = sanitizeForDisplay(record.stdout ?? record.error ?? "");
    const clipped = output.length > 4000 ? `${output.slice(0, 2000)}\n…\n${output.slice(-2000)}` : output;
    this.pendingContext.push(`[The user ran \`${command}\` in the shell themselves${record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""}. Output:\n${clipped}\n]`);
  }

  private async interactiveTurn(rawInput: string, _display?: string): Promise<void> {
    const rt = await this.ensureRuntime();
    let prompt = rawInput;

    if (rt.hooks) {
      rt.hooks.resetStopContinuations();
      const checked = await rt.hooks.runUserPromptSubmit(rawInput);
      if (checked.blocked) {
        this.renderer.warn(`Prompt blocked by hook: ${checked.blocked}`);
        return;
      }
      if (checked.context) prompt = `${prompt}\n\n${checked.context}`;
    }
    if (rt.sessionStartContext && rt.engine.messages.length <= 1) {
      prompt = `${prompt}\n\n${rt.sessionStartContext}`;
    }
    const mentions = expandMentions(prompt, rt.cwd);
    prompt = mentions.text;
    if (mentions.files.length > 0) {
      this.renderer.dimInfo(`Attached: ${mentions.files.join(", ")}`);
    }
    if (this.pendingContext.length > 0) {
      prompt = `${this.pendingContext.join("\n\n")}\n\n${prompt}`;
      this.pendingContext = [];
    }

    const controller = new AbortController();
    this.turnAbort = controller;
    this.ui.setBusy(true);

    let outcome;
    try {
      outcome = await runTrackedTurn(rt, prompt, { signal: controller.signal, recordedPrompt: rawInput });
    } finally {
      this.turnAbort = undefined;
      this.renderer.streamEnd();
      this.ui.setBusy(false);
    }
    const { result, receipt, receiptLines } = outcome;
    if (result.stopReason === "error") {
      const explained = explainError(result.error ?? "unknown error", rt.provider);
      this.renderer.error(explained.headline);
      if (explained.hint) this.renderer.dimInfo(`  ${explained.hint}`);
    } else if (result.stopReason === "aborted") {
      this.renderer.dimInfo("Interrupted — tell RevCode what to do differently.");
    } else if (result.stopReason === "max_iterations") {
      this.renderer.warn(`Stopped after ${result.iterations} tool-loop iterations. Say "continue" to keep going.`);
    } else if (result.stopReason === "cost_limit") {
      this.renderer.warn(`Stopped at the spending cap (${formatUsd(rt.spend.spentUsd)} spent). Raise it with /cost <dollars> to keep going.`);
    }

    this.lastReceipt = receipt;
    // A receipt documents what changed or ran; a read-only turn has nothing to report.
    if (receipt.files.length > 0 || receipt.commands.length > 0 || receipt.toolErrors > 0) {
      this.renderer.receipt(receiptLines);
    }
    this.renderer.turnSummary({
      durationMs: result.durationMs,
      toolCalls: result.toolCalls,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      stopReason: result.stopReason,
      costUsd: receipt.costUsd,
    });
    this.saveSessionSnapshot(rt);
    this.renderer.setContextPercent((rt.engine.estimatedTokens() / rt.profile.contextLimit) * 100);
    if (result.durationMs > 10_000) this.ui.notify("RevCode finished");
    if (rt.permissions.getMode() === "plan" && result.stopReason === "complete" && result.finalContent.trim().length >= 200) {
      await this.offerPlanExecution(rt);
    }
  }

  /** In plan mode, a finished plan is followed by the choice to carry it out. */
  private async offerPlanExecution(rt: Runtime): Promise<void> {
    const { style } = this;
    const choice = await this.ui.select({
      title: [`${style.paint("accent", style.glyphs.bullet)} ${style.bold("Ready to carry out this plan?")}`],
      options: [{ label: "Yes, and accept edits automatically" }, { label: "Yes, but ask before each change" }, { label: "No, keep planning" }],
      hotkeys: { y: 0, n: 2 },
      cancelIndex: 2,
    });
    if (choice !== 0 && choice !== 1) return;
    rt.permissions.setMode(choice === 0 ? "accept-edits" : "ask");
    this.refreshStatus();
    const prompt = "Go ahead and implement the plan.";
    this.renderer.echoUser(prompt);
    await this.interactiveTurn(prompt);
  }

  private saveSessionSnapshot(rt: Runtime): void {
    try {
      saveSession({
        meta: {
          id: rt.sessionId,
          cwd: this.args.cwd,
          provider: rt.provider,
          model: this.currentModel,
          title: deriveTitle(rt.engine.messages),
          createdAt: this.sessionCreatedAt,
          updatedAt: new Date().toISOString(),
          turns: rt.turn.value,
          universeId: rt.universe?.id,
        },
        messages: rt.engine.messages,
      });
    } catch {
      // Persistence is best-effort; never fail a turn over it.
    }
  }

  /**
   * Leaving with changes that only exist in the copy: offer to apply them first.
   * Returns true to stay in the session (the user chose to keep working).
   */
  private async offerLandBeforeExit(): Promise<boolean> {
    const universe = this.runtime?.universe;
    if (!universe || universe.meta.status !== "active" || !this.ui.interactive) return false;
    let files = 0;
    try {
      files = (await universe.diffStat()).files;
    } catch {
      return false;
    }
    if (files === 0) return false;
    const { style } = this;
    const choice = await this.ui.select({
      title: [`${style.paint("warn", style.glyphs.warn)} ${style.bold(`${plural(files, "changed file")} ${files === 1 ? "is" : "are"} only in the private copy.`)}`],
      options: [{ label: "Apply to my project, then quit" }, { label: `Keep ${files === 1 ? "it" : "them"} for later and quit` }, { label: "Stay" }],
      hotkeys: { y: 0, a: 0, k: 1, n: 1, s: 2 },
      cancelIndex: 2,
      footer: "enter to select · esc to stay",
    });
    if (choice === 2 || choice === undefined) return true;
    if (choice === 0) {
      const flow = await landFlow(universe, {
        confirm: async (_plan, lines) => {
          this.renderer.info(lines.join("\n"));
          return true;
        },
      });
      this.renderer.info(landOutcome(flow).join("\n"));
      // Something could not be applied (a conflict): stay so the user can sort it out.
      if (!flow.landed || (flow.result && flow.result.conflicts.length > 0)) {
        this.renderer.dimInfo("Some changes were not applied. Fix them, /land again, or /exit to keep them in the copy for later.");
        return true;
      }
    }
    return false;
  }

  private async exitSummary(): Promise<void> {
    const rt = this.runtime;
    const universe = rt?.universe;
    if (universe && universe.meta.status === "active") {
      try {
        const stat = await universe.diffStat();
        if (stat.files > 0) {
          this.renderer.info(
            `${plural(stat.files, "changed file")} (+${stat.insertions} ${this.style.glyphs.minus}${stat.deletions}) ${stat.files === 1 ? "is" : "are"} waiting in the private copy.\n  Pick up where you left off: revcode -r ${rt?.sessionId}\n  Or apply them now:        revcode universes land ${universe.id}`,
          );
        } else if (universe.meta.landedCount === 0 && rt) {
          // Nothing was ever changed here: don't leave an empty copy behind.
          universe.purge();
          rt.universe = undefined;
          if (rt.turn.value > 0) this.saveSessionSnapshot(rt);
        }
      } catch {
        // best effort
      }
    }
    let summary: string | undefined;
    if (rt && rt.turn.value > 0) {
      const usage = rt.engine.stats.usage;
      const cost = rt.price || rt.spend.spentUsd > 0 ? ` ${this.style.glyphs.dot} ${formatUsd(rt.spend.spentUsd)}` : "";
      summary = `${plural(rt.turn.value, "turn")} ${this.style.glyphs.dot} ${formatTokens(usage.inputTokens)} in ${this.style.glyphs.dot} ${formatTokens(usage.outputTokens)} out${cost} ${this.style.glyphs.dot} ${formatDuration(Date.now() - this.startedAt)}`;
    }
    this.renderer.goodbye(summary);
    if (rt && rt.turn.value > 0 && !rt.universe) this.renderer.dimInfo(`Resume with: revcode -r ${rt.sessionId}`);
  }

  // --- slash commands ---------------------------------------------------------

  private commandContext(rt: Runtime): CommandContext {
    const loaded = loadConfig(this.args.cwd);
    return {
      rt,
      args: this.args,
      renderer: this.renderer,
      style: this.style,
      caps: this.caps,
      startedAt: this.startedAt,
      configFiles: loaded.files,
      configWarnings: loaded.warnings,
      slashCommands: () => this.slashCommands(),
      getModel: () => this.currentModel,
      setModel: (model) => this.setModel(model),
      getLastReceipt: () => this.lastReceipt,
      runPrompt: (prompt, display) => this.interactiveTurn(prompt, display),
      adoptSession: (snapshot) => this.adoptSession(rt, snapshot),
      refreshStatus: () => this.refreshStatus(),
      toggleVim: () => {
        if (!this.editor) return false;
        this.editor.setVim(!this.editor.isVim());
        this.ui.refresh();
        return this.editor.isVim();
      },
    };
  }

  /** Swap the running conversation for a saved one (`/resume`). */
  private adoptSession(rt: Runtime, snapshot: SessionSnapshot): void {
    const rest = snapshot.messages.filter((m) => m.role !== "system");
    rt.engine.messages.splice(1, Math.max(0, rt.engine.messages.length - 1), ...rest);
    rt.sessionId = snapshot.meta.id;
    rt.turn.value = snapshot.meta.turns;
    this.sessionCreatedAt = snapshot.meta.createdAt;
    this.renderer.setContextPercent((rt.engine.estimatedTokens() / rt.profile.contextLimit) * 100);
    this.renderer.success(`Resumed “${snapshot.meta.title}” — ${plural(rest.length, "message")}.`);
    const lastUser = [...rest].reverse().find((m) => m.role === "user" && !(m.content ?? "").startsWith("[harness]"));
    const lastAssistant = [...rest].reverse().find((m) => m.role === "assistant" && (m.content ?? "").trim().length > 0);
    if (lastUser) this.renderer.echoUser((lastUser.content ?? "").split("\n")[0].slice(0, 200));
    if (lastAssistant) this.renderer.assistant(lastAssistant.content ?? "");
  }

  private async handleSlashCommand(line: string): Promise<boolean> {
    const trimmed = line.trim();
    // "/usr/bin/foo is missing" is a message, not a command.
    if (!/^\/[A-Za-z][\w:.-]*(\s|$)/.test(trimmed)) {
      return false;
    }
    const [rawName, ...rest] = trimmed.split(/\s+/);
    const name = rawName.toLowerCase();
    const arg = rest.join(" ").trim();
    const rt = await this.ensureRuntime();

    if (name === "/exit" || name === "/quit") {
      return false;
    }
    if (UNIVERSE_COMMANDS.has(name)) {
      await this.handleUniverseCommand(rt, name, arg);
      return true;
    }
    if (await runCommand(this.commandContext(rt), name, arg)) {
      return true;
    }
    return this.handleCustomCommand(rt, name.slice(1), arg);
  }

  private async handleCustomCommand(rt: Runtime, name: string, arg: string): Promise<boolean> {
    const parsed = parseSlashInput(`/${name} ${arg}`);
    const command = parsed ? findCommand(rt.commands, parsed.name) : undefined;
    if (!command || !parsed) {
      const known = this.slashCommands().map((c) => c.command);
      const guess = rankByFuzzy(name, known, (c) => c.slice(1), 1)[0];
      this.renderer.error(`Unknown command: /${name}.${guess ? ` Did you mean ${guess}?` : ""} Type /help for the list.`);
      return true;
    }
    await this.interactiveTurn(expandCommand(command, parsed.args));
    return true;
  }

  /** `/diff` outside a universe: what has changed in the working tree, as a readable diff. */
  private async showGitDiff(arg: string): Promise<void> {
    const run = (args: string[]): Promise<string | undefined> =>
      new Promise((resolve) => {
        execFile("git", args, { cwd: this.args.cwd, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (error, stdout) => resolve(error ? undefined : String(stdout)));
      });
    const stat = await run(["diff", "HEAD", "--stat", "--no-color"]);
    if (stat === undefined) {
      this.renderer.dimInfo("No git repository here, so there is nothing to diff. Parallel Universes (revcode --universe) track changes anywhere.");
      return;
    }
    if (stat.trim() === "") {
      this.renderer.dimInfo("No uncommitted changes.");
      return;
    }
    this.renderer.info(stat.trimEnd());
    if (arg === "full" || arg.startsWith("-")) {
      const diff = (await run(["diff", "HEAD", "--no-color", "--unified=3"])) ?? "";
      const view = renderDiffView(diff, { style: this.style, width: this.renderer.contentWidth(), maxRows: 400, showFileNames: true });
      this.renderer.info(view.rows.join("\n"));
    } else {
      this.renderer.dimInfo("(/diff full for the complete diff)");
    }
  }

  // --- universe commands --------------------------------------------------------

  private async handleUniverseCommand(rt: Runtime, name: string, arg: string): Promise<void> {
    const universe = rt.universe;
    if (name === "/universes") {
      this.renderer.info(formatUniverseList(Universe.list({ projectRoot: this.args.cwd })).join("\n"));
      return;
    }
    if (!universe) {
      if (name === "/diff") {
        await this.showGitDiff(arg);
        return;
      }
      this.renderer.info("This session is not in a Parallel Universe. Start one with: revcode --universe");
      return;
    }

    switch (name) {
      case "/checkpoints":
        this.renderer.info(describeUniverse(universe.meta).join("\n") + "\n\n" + formatCheckpoints(universe.checkpoints()).join("\n"));
        return;
      case "/diff": {
        const changes = await universe.changesBetween(universe.meta.baseSha, await universe.snapshotHead("diff"));
        this.renderer.info(formatChangeSummary(changes).join("\n"));
        if (arg === "full" || arg.startsWith("-")) {
          const diff = await universe.diff(arg === "full" ? [] : []);
          const view = renderDiffView(diff.split("\n").slice(0, 600).join("\n"), { style: this.style, width: this.renderer.contentWidth(), maxRows: 120 });
          this.renderer.info(view.rows.join("\n"));
        } else if (changes.length > 0) {
          this.renderer.info("(/diff full for the complete diff)");
        }
        return;
      }
      case "/land": {
        const flags = arg.split(/\s+/).filter(Boolean);
        const onConflict = flags.includes("--theirs") ? "theirs" : flags.includes("--markers") ? "markers" : "skip";
        const paths = flags.filter((f) => !f.startsWith("--"));
        const flow = await landFlow(universe, {
          paths,
          onConflict,
          confirm: async (_plan, lines) => {
            this.renderer.info(lines.join("\n"));
            return confirmYesNo(this.renderer, `Apply these changes to ${universe.meta.projectRoot}?`);
          },
        });
        this.renderer.info(landOutcome(flow).join("\n"));
        return;
      }
      case "/rewind": {
        const n = Number.parseInt(arg, 10);
        const checkpoints = universe.checkpoints();
        if (!Number.isInteger(n)) {
          this.renderer.info(`${formatCheckpoints(checkpoints, 15).join("\n")}\n\nUsage: /rewind <number>  (files and conversation return to that point; the current state is saved first)`);
          return;
        }
        const target = universe.checkpointByNumber(n);
        if (!target) {
          this.renderer.error(`No checkpoint #${n}.`);
          return;
        }
        await universe.rewind(n);
        if (target.messageCount !== undefined) {
          const kept = truncateToConsistent(rt.engine.messages, target.messageCount);
          rt.engine.messages.splice(0, rt.engine.messages.length, ...kept);
        }
        rt.engine.messages.push({
          role: "user",
          content: `[harness] The workspace${target.messageCount !== undefined ? " and conversation were" : " was"} rewound to checkpoint #${n} ("${target.summary}"). Files changed after that point were reverted; re-read anything you rely on.`,
        });
        this.renderer.info(`Rewound to #${n}: ${target.summary}`);
        this.renderer.setContextPercent((estimateTokens(rt.engine.messages) / rt.profile.contextLimit) * 100);
        return;
      }
      case "/fork": {
        const n = arg ? Number.parseInt(arg, 10) : undefined;
        if (arg && !Number.isInteger(n)) {
          this.renderer.error("Usage: /fork [checkpoint number]");
          return;
        }
        const child = await universe.fork(n);
        const cp = n === undefined ? undefined : universe.checkpointByNumber(n);
        const count = cp?.messageCount ?? rt.engine.messages.length;
        const messages = truncateToConsistent(rt.engine.messages, count);
        const forkSession = `${rt.sessionId}-fork`;
        saveSession({
          meta: {
            id: forkSession,
            cwd: this.args.cwd,
            provider: rt.provider,
            model: this.currentModel,
            title: `fork of ${deriveTitle(messages)}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            turns: rt.turn.value,
            universeId: child.id,
          },
          messages,
        });
        this.renderer.info(`Forked ${universe.id} → ${child.id}. Continue in the fork with: revcode -r ${forkSession}`);
        return;
      }
      case "/discard": {
        if (!(await confirmYesNo(this.renderer, `Throw away universe ${universe.id} and all its changes?`))) {
          this.renderer.dimInfo("Kept.");
          return;
        }
        universe.discard();
        this.renderer.info(`Universe ${universe.id} discarded. Exiting.`);
        this.dispose();
        process.exit(0);
      }
    }
  }

  // --- helpers ------------------------------------------------------------------

  private async resolveHeadlessInstruction(): Promise<string> {
    if (this.args.prompt) {
      return this.args.prompt;
    }
    if (input.isTTY) {
      throw new Error("Headless mode requires --prompt or piped stdin instruction");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const instruction = Buffer.concat(chunks).toString("utf8").trim();
    if (!instruction) {
      throw new Error("Headless mode requires a non-empty instruction");
    }
    return instruction;
  }

  private async writeTrajectory(): Promise<void> {
    if (!this.args.trajectoryOut || !this.runtime) {
      return;
    }
    const lines = this.runtime.engine.trajectory.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(this.args.trajectoryOut, `${lines}\n`, "utf8");
  }
}

function isPlanResult(result: unknown): result is { steps: Array<{ step: string; status: string }> } {
  return typeof result === "object" && result !== null && Array.isArray((result as { steps?: unknown }).steps);
}

function shouldExit(userInput: string): boolean {
  const normalized = userInput.trim().toLowerCase();
  return normalized === "/exit" || normalized === "/quit" || normalized === "exit";
}

// Re-exports kept for existing consumers and tests.
export { SUGGESTED_GLM_MODELS, segmentToolCalls };
