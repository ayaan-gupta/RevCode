/**
 * Agent — the terminal shell around the engine.
 *
 * Owns the process-level concerns: parsing slash commands, reading input,
 * rendering, approvals, Ctrl-C, session saving, and the headless output formats.
 * Everything about *how the model works* lives in the engine and runtime setup,
 * so the same logic also drives subagents, Dyno benchmarks, and replays.
 */

import { stdin as input } from "node:process";
import { writeFile } from "node:fs/promises";
import type { CliArgs } from "../cli.js";
import type { LlmToolCall } from "../llm/client.js";
import { DEFAULT_PROFILE } from "../harness/profile.js";
import { buildSystemPrompt as buildPrompt } from "../harness/prompt.js";
import { expandCommand, findCommand, parseSlashInput } from "../skills/index.js";
import { createTerminalApprover } from "../tui/approval.js";
import { renderDiff } from "../tui/format.js";
import { expandMentions } from "../tui/mentions.js";
import { readBoxedInput } from "../tui/input.js";
import { TerminalRenderer } from "../tui/render.js";
import { registerSlashCommands } from "../tui/slash-commands.js";
import type { SpinnerHandle } from "../tui/spinner.js";
import { truncateToConsistent } from "../universe/recorder.js";
import { formatReceipt, type Receipt } from "../universe/receipts.js";
import {
  describeUniverse,
  formatCheckpoints,
  formatChangeSummary,
  formatUniverseList,
  landFlow,
} from "../universe/ui.js";
import { Universe } from "../universe/universe.js";
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

export class Agent {
  private args: CliArgs;
  private readonly renderer: TerminalRenderer;
  private readonly interactive: boolean;
  private currentModel: string;
  private runtime?: Runtime;
  private activeSpinner: SpinnerHandle | undefined;
  private turnAbort?: AbortController;
  private lastSigint = 0;
  private lastReceipt?: Receipt;
  private resumed?: SessionSnapshot;
  private sessionCreatedAt = new Date().toISOString();
  private disposed = false;

  constructor(args: CliArgs) {
    this.args = args;
    this.interactive = !args.headless;
    this.currentModel = args.model;
    this.renderer = new TerminalRenderer(args, process.stdout.isTTY);
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
      const now = Date.now();
      if (this.turnAbort && !this.turnAbort.signal.aborted && now - this.lastSigint > 3000) {
        this.lastSigint = now;
        this.turnAbort.abort();
        this.runtime?.tools.interruptShell();
        this.renderer.info("\nInterrupted. Press Ctrl-C again within 3s to quit.");
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
      this.renderer.info(`Profile: ${switched.profileSource}`);
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

  // --- runtime ----------------------------------------------------------------

  private async ensureRuntime(task?: string): Promise<Runtime> {
    if (this.runtime) {
      return this.runtime;
    }
    const observer = this.interactive ? this.interactiveObserver() : this.headlessObserver();
    const approver = this.interactive ? createTerminalApprover(this.renderer) : undefined;
    const warn = (message: string): void => {
      if (this.interactive) this.renderer.info(`! ${message}`);
      else process.stderr.write(`[revcode] ${message}\n`);
    };

    let universe: Universe | undefined;
    if (this.resumed?.meta.universeId) {
      try {
        universe = Universe.open(this.resumed.meta.universeId);
        if (universe.meta.status === "discarded") universe = undefined;
      } catch {
        warn(`Universe ${this.resumed.meta.universeId} no longer exists; continuing without it.`);
      }
    }

    this.runtime = await createRuntime({
      args: { ...this.args, model: this.currentModel },
      interactive: this.interactive,
      observer,
      approver,
      warn,
      confirm: this.interactive && approver
        ? async (question) => {
            const answer = await approver({ tool: "trust", args: {}, summary: question, reason: "Project trust" });
            return answer !== "deny";
          }
        : undefined,
      sessionId: this.resumed?.meta.id,
      initialMessages: this.resumed?.messages,
      universe,
      task,
    });
    registerSlashCommands(this.runtime.commands.map((c) => ({ command: `/${c.name}`, description: c.description })));
    this.refreshStatus();
    return this.runtime;
  }

  private refreshStatus(): void {
    const rt = this.runtime;
    if (!rt) return;
    const parts: string[] = [rt.permissions.getMode()];
    if (rt.universe) parts.push(`universe ${rt.universe.id}`);
    this.renderer.setStatusLabel(parts.join(" · "));
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

    const summary = {
      result: turn.finalContent,
      stopReason: turn.stopReason,
      iterations: turn.iterations,
      toolCalls: turn.toolCalls,
      toolErrors: turn.toolErrors,
      durationMs: turn.durationMs,
      usage: turn.usage,
      model: this.currentModel,
      profile: runtime.profileSource,
      universe: runtime.universe?.id,
      ...(turn.error ? { error: turn.error } : {}),
    };
    if (this.args.outputFormat === "json" || this.args.outputFormat === "stream-json") {
      console.log(JSON.stringify(this.args.outputFormat === "stream-json" ? { type: "result", ...summary } : summary));
    } else if (runtime.universe) {
      const stat = await runtime.universe.diffStat();
      console.log(`\nUniverse ${runtime.universe.id}: ${stat.files} file(s) changed (+${stat.insertions} −${stat.deletions}). Land with: revcode universes land ${runtime.universe.id}`);
    }
    if (turn.stopReason === "error") {
      process.stderr.write(`[revcode] ${turn.error ?? "model request failed"}\n`);
      process.exitCode = 1;
    }
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
    return {
      llmStart: () => {
        this.activeSpinner = this.renderer.startThinking();
      },
      textDelta: (text) => {
        this.stopSpinner();
        this.renderer.streamAssistant(text);
      },
      llmEnd: ({ content, streamed }) => {
        if (this.renderer.isStreaming()) {
          this.renderer.endStream();
        } else {
          this.stopSpinner();
          if (content && !streamed) this.renderer.assistant(content);
        }
        this.stopSpinner();
      },
      toolCall: (call) => {
        this.stopSpinner();
        this.renderer.toolCall(call.name, call.arguments);
      },
      toolResult: (call, result) => {
        if (call.name === "update_plan" && isPlanResult(result)) {
          this.renderer.plan(result.steps);
        } else {
          this.renderer.toolResult(call.name, result);
        }
      },
      compaction: (removed) => this.renderer.info(`Compacted context (~${removed} tokens reclaimed).`),
      notice: (message) => this.renderer.info(message),
    };
  }

  private async runInteractive(): Promise<void> {
    if (this.args.resume !== undefined) {
      this.loadResume();
    }
    this.renderer.welcome();
    const runtime = await this.ensureRuntime();

    const info: string[] = [`Profile: ${runtime.profileSource} · mode: ${runtime.permissions.getMode()}`];
    if (runtime.universe) {
      info.push(`Universe ${runtime.universe.id} — changes stay isolated until you /land them.`);
    }
    if (this.resumed) {
      info.push(`Resumed session ${this.resumed.meta.id} (${this.resumed.meta.title}).`);
    }
    for (const line of info) this.renderer.info(this.renderer.isRich() ? `\x1b[2m${line}\x1b[0m` : line);

    while (true) {
      const userInput = await readBoxedInput({ renderer: this.renderer });
      if (userInput === null || shouldExit(userInput)) {
        break;
      }
      if (await this.handleSlashCommand(userInput)) {
        continue;
      }
      await this.interactiveTurn(userInput);
    }

    await this.exitSummary();
    this.renderer.goodbye();
  }

  private loadResume(): void {
    const wanted = this.args.resume ?? "";
    const id = wanted || latestSession(this.args.cwd)?.id;
    const snapshot = id ? loadSession(id) : undefined;
    if (!snapshot) {
      this.renderer.info(id ? `Session ${id} not found; starting fresh.` : "No previous session in this directory; starting fresh.");
      return;
    }
    this.resumed = snapshot;
    this.sessionCreatedAt = snapshot.meta.createdAt;
    if (!this.args.explicit?.includes("model") && snapshot.meta.model) {
      this.currentModel = snapshot.meta.model;
    }
  }

  private async interactiveTurn(rawInput: string): Promise<void> {
    const rt = await this.ensureRuntime();
    let prompt = rawInput;

    if (rt.hooks) {
      rt.hooks.resetStopContinuations();
      const checked = await rt.hooks.runUserPromptSubmit(rawInput);
      if (checked.blocked) {
        this.renderer.info(`Prompt blocked by hook: ${checked.blocked}`);
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
      this.renderer.info(`Attached: ${mentions.files.join(", ")}`);
    }

    this.renderer.beginTurn(rawInput);
    const controller = new AbortController();
    this.turnAbort = controller;

    let outcome;
    try {
      outcome = await runTrackedTurn(rt, prompt, { signal: controller.signal, recordedPrompt: rawInput });
    } finally {
      this.turnAbort = undefined;
      this.stopSpinner();
    }
    const { result, receipt, receiptLines } = outcome;
    if (result.stopReason === "error") {
      this.renderer.error(`Request failed: ${result.error ?? "unknown error"}`);
    } else if (result.stopReason === "aborted") {
      this.renderer.info("Turn aborted.");
    }

    this.lastReceipt = receipt;
    if (result.toolCalls > 0) {
      this.renderer.receipt(receiptLines);
    }
    this.saveSessionSnapshot(rt);
    this.renderer.setContextPercent((rt.engine.estimatedTokens() / rt.profile.contextLimit) * 100);
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

  private async exitSummary(): Promise<void> {
    const universe = this.runtime?.universe;
    if (!universe || universe.meta.status !== "active") return;
    try {
      const stat = await universe.diffStat();
      if (stat.files > 0) {
        this.renderer.info(
          `Universe ${universe.id} holds ${stat.files} unlanded file change${stat.files === 1 ? "" : "s"} (+${stat.insertions} −${stat.deletions}).\n  Review: revcode universes diff ${universe.id}\n  Land:   revcode universes land ${universe.id}\n  Resume: revcode -r ${this.runtime?.sessionId}`,
        );
      }
    } catch {
      // best effort
    }
  }

  // --- slash commands ---------------------------------------------------------

  private async handleSlashCommand(line: string): Promise<boolean> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) {
      return false;
    }
    const [rawName, ...rest] = trimmed.split(/\s+/);
    const name = rawName.toLowerCase();
    const arg = rest.join(" ").trim();
    const rt = await this.ensureRuntime();

    switch (name) {
      case "/help":
        this.renderer.info(this.helpText(rt));
        return true;
      case "/memory":
        this.renderer.info(JSON.stringify(rt.engine.messages, null, 2));
        return true;
      case "/tools":
        this.renderer.info(JSON.stringify(rt.tools.definitions(), null, 2));
        return true;
      case "/tokens": {
        const used = rt.engine.estimatedTokens();
        const limit = rt.profile.contextLimit;
        const real = rt.engine.stats.usage;
        this.renderer.info(
          `Context: ~${used.toLocaleString()} / ${limit.toLocaleString()} est. tokens (${Math.round((used / limit) * 100)}%).` +
            (real.inputTokens > 0 ? `\nSession usage: ${real.inputTokens.toLocaleString()} in (${(real.cachedInputTokens ?? 0).toLocaleString()} cached) · ${real.outputTokens.toLocaleString()} out · ${rt.engine.stats.apiCalls} calls` : ""),
        );
        return true;
      }
      case "/compact": {
        const result = rt.engine.compactNow();
        this.renderer.info(result.compacted ? `Compacted context (~${result.removedTokens} tokens reclaimed).` : "Nothing to compact yet.");
        return true;
      }
      case "/clear":
        rt.engine.reset();
        this.renderer.info("Conversation cleared.");
        return true;
      case "/model":
        this.handleModelCommand(arg);
        return true;
      case "/mode":
        this.handleModeCommand(rt, arg);
        return true;
      case "/plan":
        this.handleModeCommand(rt, rt.permissions.getMode() === "plan" ? "ask" : "plan");
        return true;
      case "/profile":
        this.renderer.info(`Profile source: ${rt.profileSource}\n${JSON.stringify(rt.profile, null, 2)}`);
        return true;
      case "/sessions": {
        const sessions = listSessions({ cwd: this.args.cwd }).slice(0, 15);
        this.renderer.info(
          sessions.length === 0
            ? "No saved sessions for this directory."
            : sessions.map((s) => `${s.id}  ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${s.model}  ${s.title}`).join("\n") + "\nResume with: revcode -r <id>",
        );
        return true;
      }
      case "/receipt":
        this.renderer.info(this.lastReceipt ? receiptDetails(this.lastReceipt) : "No receipt yet — run a task first.");
        return true;
      case "/diff":
      case "/land":
      case "/checkpoints":
      case "/rewind":
      case "/fork":
      case "/universes":
      case "/discard":
        await this.handleUniverseCommand(rt, name, arg);
        return true;
      case "/exit":
      case "/quit":
        return false;
      default:
        return this.handleCustomCommand(rt, name.slice(1), arg);
    }
  }

  private async handleCustomCommand(rt: Runtime, name: string, arg: string): Promise<boolean> {
    const parsed = parseSlashInput(`/${name} ${arg}`);
    const command = parsed ? findCommand(rt.commands, parsed.name) : undefined;
    if (!command || !parsed) {
      this.renderer.info(`Unknown command: /${name}. Type /help for available commands.`);
      return true;
    }
    await this.interactiveTurn(expandCommand(command, parsed.args));
    return true;
  }

  private helpText(rt: Runtime): string {
    const lines = [
      "/model [name]   show or switch the model",
      "/mode [m]       permission mode: ask | accept-edits | plan | yolo   (/plan toggles read-only)",
      "/tokens /compact /clear /memory /tools /profile /sessions /receipt",
      rt.universe
        ? "/diff /land [paths] [--markers|--theirs] /checkpoints /rewind [n] /fork [n] /universes /discard   (Parallel Universe commands)"
        : "Parallel Universes: restart with `revcode --universe` for isolated, recorded, landable runs.",
      "/exit           quit",
    ];
    if (rt.commands.length > 0) {
      lines.push(`Custom: ${rt.commands.map((c) => `/${c.name}`).join(" ")}`);
    }
    return lines.join("\n");
  }

  private handleModelCommand(modelArg: string): void {
    if (!modelArg) {
      const lines = SUGGESTED_GLM_MODELS.map((model) => `  ${model}${model === this.currentModel ? " (current)" : ""}`);
      if (!SUGGESTED_GLM_MODELS.includes(this.currentModel as (typeof SUGGESTED_GLM_MODELS)[number])) {
        lines.push(`  ${this.currentModel} (current)`);
      }
      this.renderer.info(["Suggested models:", ...lines, "", "Usage: /model <name>"].join("\n"));
      return;
    }
    try {
      this.setModel(modelArg);
      this.renderer.info(`Model switched to ${this.currentModel}.`);
    } catch (error) {
      this.renderer.error(error instanceof Error ? error.message : String(error));
    }
  }

  private handleModeCommand(rt: Runtime, arg: string): void {
    if (!arg) {
      this.renderer.info(`Permission mode: ${rt.permissions.getMode()}  (set with /mode ${PERMISSION_MODES.join(" | ")})`);
      return;
    }
    if (!(PERMISSION_MODES as readonly string[]).includes(arg)) {
      this.renderer.error(`Unknown mode "${arg}". Expected: ${PERMISSION_MODES.join(", ")}.`);
      return;
    }
    rt.permissions.setMode(arg as PermissionMode);
    this.refreshStatus();
    this.renderer.info(`Permission mode: ${arg}`);
  }

  // --- universe commands --------------------------------------------------------

  private async handleUniverseCommand(rt: Runtime, name: string, arg: string): Promise<void> {
    const universe = rt.universe;
    if (name === "/universes") {
      this.renderer.info(formatUniverseList(Universe.list({ projectRoot: this.args.cwd })).join("\n"));
      return;
    }
    if (!universe) {
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
          this.renderer.info(renderDiff(diff.split("\n").slice(0, 400).join("\n"), this.renderer.isRich()));
        } else if (changes.length > 0) {
          this.renderer.info("(/diff full for the complete diff)");
        }
        return;
      }
      case "/land": {
        const flags = arg.split(/\s+/).filter(Boolean);
        const onConflict = flags.includes("--theirs") ? "theirs" : flags.includes("--markers") ? "markers" : "skip";
        const paths = flags.filter((f) => !f.startsWith("--"));
        const approver = createTerminalApprover(this.renderer);
        const flow = await landFlow(universe, {
          paths,
          onConflict,
          confirm: async (_plan, lines) => {
            this.renderer.info(lines.join("\n"));
            const answer = await approver({ tool: "land", args: {}, summary: `Apply these changes to ${universe.meta.projectRoot}?`, reason: "Landing a universe" });
            return answer !== "deny";
          },
        });
        this.renderer.info(flow.lines.filter((l) => !flow.landed || !l.startsWith("  ") || l.includes("Landed")).join("\n"));
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
        const approver = createTerminalApprover(this.renderer);
        const answer = await approver({ tool: "discard", args: {}, summary: `Throw away universe ${universe.id} and all its changes?`, reason: "Discarding a universe" });
        if (answer === "deny") {
          this.renderer.info("Kept.");
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

  private stopSpinner(): void {
    this.activeSpinner?.stop();
    this.activeSpinner = undefined;
  }

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

function receiptDetails(receipt: Receipt): string {
  const lines = [...formatReceipt(receipt), ""];
  for (const c of receipt.commands.slice(-12)) {
    lines.push(`  $ ${c.command}  → exit ${c.exitCode ?? "?"}${c.timedOut ? " (timed out)" : ""}`);
  }
  for (const f of receipt.files.slice(0, 20)) {
    lines.push(`  ${f.status} ${f.path}${f.insertions || f.deletions ? `  (+${f.insertions} −${f.deletions})` : ""}`);
  }
  return lines.join("\n");
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
