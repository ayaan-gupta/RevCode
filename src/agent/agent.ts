/**
 * Core agent loop.
 *
 * Owns the conversation with the LLM, dispatches tool calls, and
 * renders output to the terminal.
 */

import { stdin as input, stdout as output } from "node:process";
import { writeFile } from "node:fs/promises";
import type { CliArgs } from "../cli.js";
import {
  createLlmClient,
  type LlmClient,
  type LlmMessage,
  type LlmStreamDelta,
  type LlmToolCall,
} from "../llm/client.js";
import { ToolRegistry } from "../tools/index.js";
import { estimateTokens, forceCompact, maybeCompact } from "./context.js";
import { readBoxedInput } from "../tui/input.js";
import { TerminalRenderer } from "../tui/render.js";
import type { SpinnerHandle } from "../tui/spinner.js";

/** Estimated-token budget before compaction kicks in. */
const CONTEXT_TOKEN_LIMIT = 120_000;

const DEFAULT_MAX_TOOL_ITERATIONS = 50;

const SUGGESTED_GLM_MODELS = ["glm-5.2", "glm-4.7", "glm-4.7-flash"] as const;

/**
 * Build the system prompt. Kept stable within a session (cwd/date computed
 * once) so it remains a cacheable prefix for the provider.
 */
function buildSystemPrompt(args: CliArgs): string {
  const env = [
    `- Working directory: ${args.cwd}`,
    `- Platform: ${process.platform} (${process.arch})`,
    `- Shell: a PERSISTENT bash session — cwd (cd), exported env, activated virtualenvs, and background jobs persist across shell calls`,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");

  return `You are RevCode, an expert software engineering agent operating in a terminal. You complete real coding tasks end to end by calling tools.

# Environment
${env}

# How to work
- Keep going until the task is COMPLETELY solved. Do not stop at the first obstacle or hand back a half-finished result — if something fails, read the error, diagnose it, and try another approach.
- Understand before acting: explore the relevant files/structure, then make the change, then VERIFY it works (run the tests, the script, or the server the task describes).
- Once the task's own success criteria are demonstrably met, give a brief summary and STOP. Do not keep calling tools to re-verify what already passed — redundant iteration wastes time.
- Use exact identifiers (paths, field names, function names, ports) from the task instruction verbatim. Small mismatches fail verifiers.
- When you define a schema or interface a grader will check (e.g. protobuf messages, function signatures, JSON/DB shapes), re-read the spec and match EACH field's name and type precisely against the wording for that specific field — never reuse a similar name from a neighboring message or reuse one identifier where the spec uses two distinct ones.

# Tools
- Call tools via the function-calling interface only; never emit raw XML tool markup.
- shell runs in the persistent session. To start a long-running process (server, watcher), pass background:true so it keeps running and the call returns immediately — never run a server in the foreground or the call blocks until timeout.
- Prefer list_directory / glob / grep over shell ls / find / grep. Use list_directory before reading when paths are unknown.
- read_file before edit_file; edit_file's oldText must match exactly once. write_file writes the complete file in one call. Don't re-read files you haven't changed.
- Independent read-only lookups in a single turn run in parallel — batch them when it helps.

Be concise in prose; let tool results and verification speak for themselves.`;
}

export interface TrajectoryEvent {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  timestamp: string;
  content?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  toolCallId?: string;
}

export interface AgentRunResult {
  finalContent: string;
  messages: LlmMessage[];
  trajectory: TrajectoryEvent[];
}

export class Agent {
  private readonly args: CliArgs;
  private llm: LlmClient;
  private readonly tools: ToolRegistry;
  private readonly renderer: TerminalRenderer;
  private readonly interactive: boolean;
  private currentModel: string;
  private readonly trajectory: TrajectoryEvent[] = [];
  private readonly systemPrompt: string;
  private activeSpinner: SpinnerHandle | undefined;

  private disposed = false;

  constructor(args: CliArgs) {
    this.args = args;
    this.interactive = !args.headless;
    this.currentModel = args.model;
    this.systemPrompt = buildSystemPrompt(args);
    this.llm = createLlmClient({
      model: args.model,
      provider: args.provider,
    });
    this.tools = new ToolRegistry({ cwd: args.cwd });
    this.renderer = new TerminalRenderer(args, output.isTTY);
    this.registerShutdownHandlers();
  }

  /**
   * Tear down the persistent shell session (and its process group) on every
   * exit path: normal completion, signals, and ungraceful errors. Without this,
   * a backgrounded server can leak as an orphan — especially bad in reused
   * Harbor/eval containers.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.tools.dispose();
  }

  private registerShutdownHandlers(): void {
    process.once("exit", () => this.dispose());
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        this.dispose();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  }

  async start(): Promise<void> {
    try {
      if (this.args.headless) {
        const instruction = await this.resolveHeadlessInstruction();
        // completeWithTools already echoes assistant content to stdout in
        // headless mode, so we do not reprint finalContent here.
        await this.runTask(instruction);
        await this.writeTrajectory();
        return;
      }

      this.renderer.welcome();
      const messages = this.createInitialMessages();

      while (true) {
        const userInput = await readBoxedInput({ renderer: this.renderer });
        if (userInput === null) {
          break;
        }

        if (shouldExit(userInput)) {
          break;
        }

        if (this.handleSlashCommand(userInput, messages)) {
          continue;
        }

        messages.push({ role: "user", content: userInput });
        this.renderer.beginTurn(userInput);
        await this.completeWithTools(messages);
        this.renderer.setContextPercent((estimateTokens(messages) / CONTEXT_TOKEN_LIMIT) * 100);
      }

      this.renderer.goodbye();
    } finally {
      this.dispose();
    }
  }

  setModel(model: string): void {
    const trimmed = model.trim();
    if (!trimmed) {
      throw new Error("Model name cannot be empty");
    }

    this.currentModel = trimmed;
    this.llm = createLlmClient({
      model: trimmed,
      provider: this.args.provider,
    });
    this.renderer.updateModel(trimmed);
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  async runTask(instruction: string): Promise<AgentRunResult> {
    const messages = this.createInitialMessages();
    this.recordTrajectory({
      type: "user",
      timestamp: nowIso(),
      content: instruction,
    });

    messages.push({ role: "user", content: instruction });
    const finalContent = await this.completeWithTools(messages);
    return {
      finalContent,
      messages,
      trajectory: [...this.trajectory],
    };
  }

  private createInitialMessages(): LlmMessage[] {
    this.recordTrajectory({
      type: "system",
      timestamp: nowIso(),
      content: this.systemPrompt,
    });

    return [{ role: "system", content: this.systemPrompt }];
  }

  private async completeWithTools(messages: LlmMessage[]): Promise<string> {
    const toolDefinitions = this.tools.definitions();
    const maxIterations = this.args.maxIterations || DEFAULT_MAX_TOOL_ITERATIONS;
    let finalContent = "";

    try {
      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        this.compactIfNeeded(messages);

        if (this.interactive) {
          this.activeSpinner = this.renderer.startThinking();
        }

        // In interactive mode, stream tokens live; the first text delta stops
        // the spinner and starts the assistant block.
        const onDelta = this.interactive
          ? (delta: LlmStreamDelta) => {
              if (delta.text) {
                this.stopSpinner();
                this.renderer.streamAssistant(delta.text);
              }
            }
          : undefined;

        const response = await this.llm.complete(
          messages,
          toolDefinitions,
          onDelta ? { onDelta } : undefined,
        );
        finalContent = response.content;

        if (this.interactive) {
          if (this.renderer.isStreaming()) {
            this.renderer.endStream();
          } else {
            this.stopSpinner();
            if (response.content) {
              this.renderer.assistant(response.content);
            }
          }
        } else if (response.content) {
          console.log(`\n${response.content}\n`);
        }

        if (response.content) {
          this.recordTrajectory({
            type: "assistant",
            timestamp: nowIso(),
            content: response.content,
          });
        }

        messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
        });

        if (response.toolCalls.length === 0) {
          return finalContent;
        }

        this.stopSpinner();
        await this.executeToolCalls(response.toolCalls, messages);
      }
    } finally {
      this.stopSpinner();
    }

    const limitMessage = `Stopped after ${maxIterations} tool iterations.`;
    if (this.interactive) {
      this.renderer.info(limitMessage);
    } else {
      console.log(limitMessage);
    }
    return finalContent;
  }

  private handleSlashCommand(command: string, messages: LlmMessage[]): boolean {
    const trimmed = command.trim();
    if (!trimmed.startsWith("/")) {
      return false;
    }

    const [name, ...rest] = trimmed.split(/\s+/);

    switch (name.toLowerCase()) {
      case "/help":
        this.renderer.info(
          [
            "/memory  — show full message history sent to the LLM",
            "/tools   — show tool JSON schemas",
            "/tokens  — show estimated context usage",
            "/compact — summarize old tool output to reclaim context",
            "/clear   — reset conversation to system prompt only",
            "/model   — show or switch the active model",
            "/help    — show this help",
            "/exit    — quit",
          ].join("\n"),
        );
        return true;
      case "/memory":
        this.renderer.info(JSON.stringify(messages, null, 2));
        return true;
      case "/tools":
        this.renderer.info(JSON.stringify(this.tools.definitions(), null, 2));
        return true;
      case "/tokens": {
        const used = estimateTokens(messages);
        const pct = Math.round((used / CONTEXT_TOKEN_LIMIT) * 100);
        this.renderer.info(
          `Context: ~${used.toLocaleString()} / ${CONTEXT_TOKEN_LIMIT.toLocaleString()} est. tokens (${pct}%).`,
        );
        return true;
      }
      case "/compact": {
        const result = forceCompact(messages, { tokenLimit: CONTEXT_TOKEN_LIMIT });
        if (result.compacted) {
          messages.splice(0, messages.length, ...result.messages);
          this.renderer.info(`Compacted context (~${result.removedTokens} tokens reclaimed).`);
        } else {
          this.renderer.info("Nothing to compact yet.");
        }
        return true;
      }
      case "/clear":
        messages.splice(0, messages.length, { role: "system", content: this.systemPrompt });
        this.renderer.info("Conversation cleared.");
        return true;
      case "/model":
        this.handleModelCommand(rest.join(" ").trim());
        return true;
      default:
        this.renderer.info(`Unknown command: ${name}. Type /help for available commands.`);
        return true;
    }
  }

  private handleModelCommand(modelArg: string): void {
    if (!modelArg) {
      const lines = SUGGESTED_GLM_MODELS.map((model) => {
        const marker = model === this.currentModel ? " (current)" : "";
        return `  ${model}${marker}`;
      });

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

  /**
   * Execute a turn's tool calls with position-aware batching: contiguous
   * read-only calls run concurrently, but a mutating/stateful call (shell,
   * write_file, edit_file, delete_file) runs alone and never overlaps a read,
   * preserving read-after-write correctness. Results are recorded and appended
   * to the conversation in the original order.
   */
  private async executeToolCalls(toolCalls: LlmToolCall[], messages: LlmMessage[]): Promise<void> {
    for (const segment of segmentToolCalls(toolCalls, (name) => this.tools.isReadOnly(name))) {
      // Announce + record each call in order before running the segment.
      for (const call of segment) {
        if (this.interactive) {
          this.renderer.toolCall(call.name, call.arguments);
        } else {
          console.log(`[${call.name}(${JSON.stringify(call.arguments)})]`);
        }
        this.recordTrajectory({
          type: "tool_call",
          timestamp: nowIso(),
          name: call.name,
          arguments: call.arguments,
          toolCallId: call.id,
        });
      }

      // Read-only segments (length may be >1) run concurrently; a mutating
      // segment is always a single call.
      const results =
        segment.length > 1
          ? await Promise.all(segment.map((c) => this.executeToolSafely(c.name, c.arguments)))
          : [await this.executeToolSafely(segment[0].name, segment[0].arguments)];

      segment.forEach((call, index) => {
        const result = results[index];
        this.recordTrajectory({
          type: "tool_result",
          timestamp: nowIso(),
          name: call.name,
          result,
          toolCallId: call.id,
        });
        if (this.interactive) {
          if (call.name === "update_plan" && isPlanResult(result)) {
            this.renderer.plan(result.steps);
          } else {
            this.renderer.toolResult(call.name, result);
          }
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ toolCallId: call.id, name: call.name, result }),
        });
      });
    }
  }

  private stopSpinner(): void {
    this.activeSpinner?.stop();
    this.activeSpinner = undefined;
  }

  private compactIfNeeded(messages: LlmMessage[]): void {
    const result = maybeCompact(messages, { tokenLimit: CONTEXT_TOKEN_LIMIT });
    if (!result.compacted) {
      return;
    }
    messages.splice(0, messages.length, ...result.messages);
    this.recordTrajectory({
      type: "system",
      timestamp: nowIso(),
      content: `[compaction] reclaimed ~${result.removedTokens} tokens`,
    });
    if (this.interactive) {
      this.renderer.info(`Compacted context (~${result.removedTokens} tokens reclaimed).`);
    }
  }

  private async executeToolSafely(name: string, inputValue: unknown): Promise<unknown> {
    try {
      return await this.tools.execute(name, inputValue);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
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

  private recordTrajectory(event: TrajectoryEvent): void {
    if (this.args.trajectoryOut || this.args.headless) {
      this.trajectory.push(event);
    }
  }

  private async writeTrajectory(): Promise<void> {
    if (!this.args.trajectoryOut) {
      return;
    }

    const lines = this.trajectory.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(this.args.trajectoryOut, `${lines}\n`, "utf8");
  }
}

/**
 * Split a turn's tool calls into execution segments: each run of contiguous
 * read-only calls becomes one concurrent batch; every mutating call is its own
 * single-element segment. This preserves original order and prevents a parallel
 * read from racing a mutating call.
 */
function segmentToolCalls(
  calls: LlmToolCall[],
  isReadOnly: (name: string) => boolean,
): LlmToolCall[][] {
  const segments: LlmToolCall[][] = [];
  let batch: LlmToolCall[] = [];

  for (const call of calls) {
    if (isReadOnly(call.name)) {
      batch.push(call);
      continue;
    }
    if (batch.length > 0) {
      segments.push(batch);
      batch = [];
    }
    segments.push([call]);
  }

  if (batch.length > 0) {
    segments.push(batch);
  }
  return segments;
}

function isPlanResult(
  result: unknown,
): result is { steps: Array<{ step: string; status: string }> } {
  return (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { steps?: unknown }).steps)
  );
}

function shouldExit(userInput: string): boolean {
  const normalized = userInput.trim().toLowerCase();
  return normalized === "/exit" || normalized === "/quit" || normalized === "exit";
}

function nowIso(): string {
  return new Date().toISOString();
}

export { SUGGESTED_GLM_MODELS, segmentToolCalls, buildSystemPrompt };
