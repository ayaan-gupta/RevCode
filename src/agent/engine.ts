/**
 * AgentEngine — the UI-free agent loop.
 *
 * Owns the conversation, calls the model, runs tools (through middleware), and
 * decides when a turn is over. Everything user-facing (spinner, Markdown,
 * approvals) is injected through an {@link EngineObserver}; everything that can
 * veto or decorate a tool call (permissions, hooks, universe checkpoints,
 * receipts) is a {@link ToolMiddleware}. That separation lets the same loop
 * drive the interactive TUI, headless runs, subagents, and Dyno benchmarks.
 */

import type {
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  LlmUsage,
} from "../llm/client.js";
import type { HarnessProfile } from "../harness/profile.js";
import type { TimeBudget } from "../harness/time-budget.js";
import type { ToolRegistry } from "../tools/index.js";
import { estimateTokens, forceCompact, maybeCompact, type CompactionResult } from "./context.js";
import { isContextOverflowError, summarizeHistory } from "./summarize.js";

// --- public types -----------------------------------------------------------

export interface TrajectoryEvent {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  timestamp: string;
  content?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  toolCallId?: string;
}

export interface ToolCallContext {
  call: LlmToolCall;
  /** Zero-based model iteration within the current turn. */
  iteration: number;
}

export type ToolDecision =
  | { allow: true; /** Replacement arguments (e.g. sanitized). */ input?: Record<string, unknown> }
  | { allow: false; reason: string };

export interface ToolMiddleware {
  name: string;
  /** Runs before the tool. Return `{allow:false}` to veto; the model sees the reason. */
  before?(ctx: ToolCallContext): Promise<ToolDecision | void> | ToolDecision | void;
  /** Runs after the tool. Return a value to replace the result the model sees. */
  after?(
    ctx: ToolCallContext & { result: unknown; durationMs: number },
  ): Promise<unknown> | unknown;
}

/**
 * Consulted when the model produces a final answer (no tool calls). Return a
 * message to push back to the model and keep going, or undefined to accept.
 */
export interface FinalGate {
  name: string;
  check(ctx: { finalContent: string; turnToolCalls: number }): Promise<string | undefined> | string | undefined;
}

export interface EngineObserver {
  llmStart?(): void;
  /** Streamed assistant text (only when `stream` is on). */
  textDelta?(text: string): void;
  llmEnd?(info: { content: string; streamed: boolean }): void;
  toolCall?(call: LlmToolCall): void;
  toolResult?(call: LlmToolCall, result: unknown): void;
  compaction?(removedTokens: number): void;
  notice?(message: string): void;
}

export interface EngineOptions {
  cwd: string;
  llm: LlmClient;
  profile: HarnessProfile;
  systemPrompt: string;
  tools: ToolRegistry;
  maxIterations: number;
  stream?: boolean;
  observer?: EngineObserver;
  middleware?: ToolMiddleware[];
  finalGates?: FinalGate[];
  /** Wall-clock budget: injects time nudges and ends the run cleanly near the limit. */
  timeBudget?: TimeBudget;
  /** Base delay before retrying a step after a transient stream failure (default 2000ms, scaled by attempt). */
  transientRetryDelayMs?: number;
  /** Resume from a prior conversation (must start with the system message). */
  initialMessages?: LlmMessage[];
}

export type StopReason = "complete" | "max_iterations" | "aborted" | "error" | "time_budget";

export interface TurnResult {
  finalContent: string;
  stopReason: StopReason;
  iterations: number;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
  usage: LlmUsage;
  error?: string;
}

export interface EngineStats {
  turns: number;
  iterations: number;
  toolCalls: number;
  toolErrors: number;
  apiCalls: number;
  usage: LlmUsage;
}

// --- constants --------------------------------------------------------------

/** Hard ceiling on a single tool result as serialized into the conversation. */
export const MAX_TOOL_RESULT_CHARS = 40_000;
const LOOP_WARN_AT = 3;
const LOOP_STRONG_AT = 5;
const MAX_STALL_NUDGES = 2;
const MAX_NARRATION_NUDGES = 2;

// --- engine -----------------------------------------------------------------

export class AgentEngine {
  readonly messages: LlmMessage[];
  readonly trajectory: TrajectoryEvent[] = [];
  readonly stats: EngineStats = {
    turns: 0,
    iterations: 0,
    toolCalls: 0,
    toolErrors: 0,
    apiCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  };

  private llm: LlmClient;
  private profile: HarnessProfile;
  private systemPrompt: string;
  private readonly tools: ToolRegistry;
  private readonly cwd: string;
  private readonly maxIterations: number;
  private readonly stream: boolean;
  private readonly observer: EngineObserver;
  private readonly middleware: ToolMiddleware[];
  private readonly finalGates: FinalGate[];
  private readonly timeBudget?: TimeBudget;
  private readonly transientRetryDelayMs: number;
  private recentSignatures: string[] = [];
  /** Conversation length right after the last LLM summary (avoids summarizing in a loop). */
  private summarizedAt = -100;

  constructor(options: EngineOptions) {
    this.llm = options.llm;
    this.profile = options.profile;
    this.systemPrompt = options.systemPrompt;
    this.tools = options.tools;
    this.cwd = options.cwd;
    this.maxIterations = Math.max(1, options.maxIterations);
    this.stream = options.stream ?? false;
    this.transientRetryDelayMs = options.transientRetryDelayMs ?? 2_000;
    this.observer = options.observer ?? {};
    this.middleware = options.middleware ?? [];
    this.finalGates = options.finalGates ?? [];
    this.timeBudget = options.timeBudget;

    this.messages =
      options.initialMessages && options.initialMessages.length > 0
        ? [...options.initialMessages]
        : [{ role: "system", content: options.systemPrompt }];
    this.record({ type: "system", content: this.systemPrompt });
  }

  getProfile(): HarnessProfile {
    return this.profile;
  }

  getCwd(): string {
    return this.cwd;
  }

  setLlm(llm: LlmClient): void {
    this.llm = llm;
  }

  addMiddleware(middleware: ToolMiddleware): void {
    this.middleware.push(middleware);
  }

  addFinalGate(gate: FinalGate): void {
    this.finalGates.push(gate);
  }

  /** Replace the system prompt (e.g. after a profile change) keeping the history. */
  setSystemPrompt(prompt: string, profile?: HarnessProfile): void {
    this.systemPrompt = prompt;
    if (profile) {
      this.profile = profile;
    }
    if (this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content: prompt };
    } else {
      this.messages.unshift({ role: "system", content: prompt });
    }
  }

  /** Drop the conversation back to the system prompt. */
  reset(): void {
    this.messages.splice(0, this.messages.length, { role: "system", content: this.systemPrompt });
    this.recentSignatures = [];
  }

  estimatedTokens(): number {
    return estimateTokens(this.messages);
  }

  /** Compact now (the `/compact` command). */
  compactNow(): CompactionResult {
    const result = forceCompact(this.messages, { tokenLimit: this.profile.contextLimit });
    if (result.compacted) {
      this.messages.splice(0, this.messages.length, ...result.messages);
    }
    return result;
  }

  /** Run one user turn to completion (or until aborted / out of iterations). */
  async runTurn(userInput: string, userSignal?: AbortSignal): Promise<TurnResult> {
    const started = Date.now();

    // The budget is also a hard deadline: an in-flight model call or command must not be able
    // to run past it (a run killed by the harness loses its trajectory and cleanup).
    const deadline = this.timeBudget ? new AbortController() : undefined;
    const deadlineTimer = deadline
      ? setTimeout(() => {
          deadline.abort();
          this.tools.interruptShell();
        }, this.timeBudget?.msUntilStop() ?? 0)
      : undefined;
    deadlineTimer?.unref();
    const signal = deadline ? (userSignal ? AbortSignal.any([userSignal, deadline.signal]) : deadline.signal) : userSignal;
    const abortReason = (): StopReason => (deadline?.signal.aborted && !userSignal?.aborted ? "time_budget" : "aborted");

    const turnUsage: LlmUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let iterations = 0;
    let turnToolCalls = 0;
    let turnToolErrors = 0;
    let finalContent = "";
    let stallNudges = 0;
    let narrationNudges = 0;
    let overflowRetries = 0;
    let transientRetries = 0;
    let stopReason: StopReason = "max_iterations";
    let errorMessage: string | undefined;

    this.stats.turns += 1;
    this.messages.push({ role: "user", content: userInput });
    this.record({ type: "user", content: userInput });

    try {
      for (; iterations < this.maxIterations; iterations += 1) {
        if (signal?.aborted) {
          stopReason = abortReason();
          break;
        }

        const budget = this.timeBudget?.check();
        if (budget?.expired) {
          stopReason = "time_budget";
          this.observer.notice?.("Time budget exhausted; stopping with the current state.");
          break;
        }
        if (budget?.nudge) {
          this.pushHarnessMessage(budget.nudge);
        }

        await this.compactIfNeeded(signal);
        this.observer.llmStart?.();

        // Always stream from the provider: a non-streaming request sends no bytes until the
        // whole (possibly minutes-long) generation is done, so slow reasoning turns trip the
        // header timeout and get restarted from scratch. `this.stream` only controls whether
        // text is forwarded to the observer.
        let streamed = false;
        const onDelta = (delta: { text?: string }): void => {
          if (this.stream && delta.text) {
            streamed = true;
            this.observer.textDelta?.(delta.text);
          }
        };

        let response: LlmResponse;
        try {
          response = await this.llm.complete(this.messages, this.tools.definitions(), {
            onDelta,
            signal,
            temperature: this.profile.temperature,
            maxTokens: this.profile.maxTokens,
            thinking: this.profile.thinking,
          });
        } catch (error) {
          this.observer.llmEnd?.({ content: "", streamed });
          if (signal?.aborted) {
            stopReason = abortReason();
            break;
          }
          const message = error instanceof Error ? error.message : String(error);
          // The provider says the prompt is too long: shrink the history and retry this step.
          if (isContextOverflowError(message) && overflowRetries < 2) {
            overflowRetries += 1;
            if (await this.shrinkHistory(signal)) {
              iterations -= 1;
              continue;
            }
          }
          // A dropped connection or stalled stream mid-generation is usually transient: retry
          // the step rather than ending a long-running task.
          if (isTransientStreamError(message) && transientRetries < MAX_TRANSIENT_RETRIES) {
            transientRetries += 1;
            this.observer.notice?.(`model call failed (${message.slice(0, 120)}); retrying (${transientRetries}/${MAX_TRANSIENT_RETRIES})`);
            await sleepUnlessAborted(this.transientRetryDelayMs * transientRetries, signal);
            iterations -= 1;
            continue;
          }
          stopReason = "error";
          errorMessage = message;
          break;
        }
        transientRetries = 0;

        this.stats.apiCalls += 1;
        addUsage(turnUsage, response.usage);
        addUsage(this.stats.usage, response.usage);
        finalContent = response.content;
        this.observer.llmEnd?.({ content: response.content, streamed });

        const text = response.content.trim();
        const stalled =
          response.toolCalls.length === 0 && (text === "" || response.finishReason === "length");

        // An empty turn carries nothing worth keeping (and some APIs reject empty
        // assistant messages), so only record turns with content or tool calls.
        if (!(stalled && text === "")) {
          if (response.content) {
            this.record({ type: "assistant", content: response.content });
          }
          this.messages.push({
            role: "assistant",
            content: response.content,
            toolCalls: response.toolCalls,
          });
        }

        if (response.toolCalls.length === 0) {
          // Reasoning models can burn the whole output budget thinking, leaving an
          // empty or cut-off reply. Don't mistake that for "done".
          if (stalled && stallNudges < MAX_STALL_NUDGES) {
            stallNudges += 1;
            this.pushHarnessMessage(
              text === ""
                ? "Your last response was empty. Stop deliberating: call a tool now to make progress, or give your final answer if the task is complete."
                : "Your previous response was cut off by the output token limit. Continue where you left off, keep each step short, and call a tool now instead of writing long explanations.",
            );
            continue;
          }

          // Mid-task narration ("Let me run the tests:") with no tool call would
          // otherwise end the run before the action happens.
          if (turnToolCalls > 0 && narrationNudges < MAX_NARRATION_NUDGES && looksLikeUnfinishedNarration(text)) {
            narrationNudges += 1;
            this.pushHarnessMessage(
              "You described an action but did not call a tool. Call the tool now. If the task is actually complete, reply with a short final summary instead.",
            );
            continue;
          }

          const nudge = await this.consultGates(finalContent, turnToolCalls);
          if (nudge) {
            this.observer.notice?.(`[${nudge.gate}] asking the model to double-check before finishing`);
            this.pushHarnessMessage(nudge.message);
            continue;
          }

          stopReason = "complete";
          iterations += 1;
          break;
        }

        // A reply truncated mid tool call has unreliable arguments; never run them.
        if (response.finishReason === "length") {
          const dropped = response.toolCalls;
          const last = this.messages[this.messages.length - 1];
          if (last?.role === "assistant") {
            last.toolCalls = [];
          }
          this.pushHarnessMessage(
            `Your response was cut off by the output token limit in the middle of ${dropped.length === 1 ? "a tool call" : "tool calls"} (${dropped.map((c) => c.name).join(", ")}), so nothing was executed. Retry with smaller steps: for large files, write them in several smaller pieces.`,
          );
          continue;
        }

        const executed = await this.executeToolCalls(response.toolCalls, iterations, signal);
        turnToolCalls += response.toolCalls.length;
        turnToolErrors += executed.errors;
      }
    } finally {
      clearTimeout(deadlineTimer);
      this.stats.iterations += iterations;
      this.stats.toolCalls += turnToolCalls;
      this.stats.toolErrors += turnToolErrors;
    }

    if (stopReason === "max_iterations") {
      this.observer.notice?.(`Stopped after ${this.maxIterations} tool iterations.`);
    }

    return {
      finalContent,
      stopReason,
      iterations,
      toolCalls: turnToolCalls,
      toolErrors: turnToolErrors,
      durationMs: Date.now() - started,
      usage: turnUsage,
      error: errorMessage,
    };
  }

  // --- internals ------------------------------------------------------------

  private async consultGates(
    finalContent: string,
    turnToolCalls: number,
  ): Promise<{ gate: string; message: string } | undefined> {
    for (const gate of this.finalGates) {
      const message = await gate.check({ finalContent, turnToolCalls });
      if (message) {
        return { gate: gate.name, message };
      }
    }
    return undefined;
  }

  /** Inject a harness-authored user message (nudges), recorded in the trajectory. */
  private pushHarnessMessage(text: string): void {
    const content = `[harness] ${text}`;
    this.messages.push({ role: "user", content });
    this.record({ type: "user", content });
  }

  private async compactIfNeeded(signal?: AbortSignal): Promise<void> {
    const result = maybeCompact(this.messages, {
      tokenLimit: this.profile.contextLimit,
      triggerRatio: this.profile.compactTrigger,
    });
    if (result.compacted) {
      this.messages.splice(0, this.messages.length, ...result.messages);
      this.record({ type: "system", content: `[compaction] reclaimed ~${result.removedTokens} tokens` });
      this.observer.compaction?.(result.removedTokens);
    }

    // Cheap rules weren't enough: write a handoff summary of the older work.
    if (
      estimateTokens(this.messages) > this.profile.contextLimit * 0.85 &&
      this.messages.length > this.summarizedAt + 6
    ) {
      await this.summarizeNow(signal);
    }
  }

  /** Replace older history with an LLM-written handoff summary. */
  private async summarizeNow(signal?: AbortSignal): Promise<boolean> {
    try {
      const summary = await summarizeHistory(this.llm, this.messages, { signal });
      if (!summary) {
        return false;
      }
      this.messages.splice(0, this.messages.length, ...summary.messages);
      this.summarizedAt = this.messages.length;
      this.record({ type: "system", content: `[summary] earlier work condensed (~${Math.round(summary.removedChars / 4)} tokens reclaimed)` });
      this.observer.notice?.("Condensed earlier work into a summary to stay within the context window.");
      return true;
    } catch (error) {
      if (!signal?.aborted) {
        this.observer.notice?.(`Could not summarize history: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
  }

  /** Emergency shrink after a context-overflow error: summary first, tighter rules as a fallback. */
  private async shrinkHistory(signal?: AbortSignal): Promise<boolean> {
    if (await this.summarizeNow(signal)) {
      return true;
    }
    const forced = forceCompact(this.messages, { tokenLimit: this.profile.contextLimit, keepLastN: 6 });
    if (forced.compacted) {
      this.messages.splice(0, this.messages.length, ...forced.messages);
      this.observer.compaction?.(forced.removedTokens);
      return true;
    }
    return false;
  }

  /**
   * Position-aware batching: contiguous read-only calls run concurrently (when
   * the profile allows), a mutating/stateful call runs alone, and results are
   * appended to the conversation in the model's original order.
   */
  private async executeToolCalls(
    toolCalls: LlmToolCall[],
    iteration: number,
    signal?: AbortSignal,
  ): Promise<{ errors: number }> {
    let errors = 0;
    const segments = this.profile.parallelTools
      ? segmentToolCalls(toolCalls, (name) => this.tools.isReadOnly(name))
      : toolCalls.map((call) => [call]);

    for (const segment of segments) {
      for (const call of segment) {
        this.observer.toolCall?.(call);
        this.record({
          type: "tool_call",
          name: call.name,
          arguments: call.arguments,
          toolCallId: call.id,
        });
      }

      let results: unknown[];
      if (signal?.aborted) {
        results = segment.map(() => ({ error: "Aborted by user before this tool ran." }));
      } else if (segment.length > 1) {
        results = await Promise.all(segment.map((call) => this.runToolCall(call, iteration)));
      } else {
        results = [await this.runToolCall(segment[0], iteration)];
      }

      segment.forEach((call, index) => {
        const result = results[index];
        if (isErrorResult(result)) {
          errors += 1;
        }
        this.record({ type: "tool_result", name: call.name, result, toolCallId: call.id });
        this.observer.toolResult?.(call, result);
        this.messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ toolCallId: call.id, name: call.name, result }),
        });
      });
    }
    return { errors };
  }

  private async runToolCall(call: LlmToolCall, iteration: number): Promise<unknown> {
    let args = call.arguments;
    const invalidJson = invalidArgumentsError(call);
    if (invalidJson) {
      return { error: invalidJson };
    }

    for (const mw of this.middleware) {
      const decision = await mw.before?.({ call: { ...call, arguments: args }, iteration });
      if (decision && !decision.allow) {
        return { error: decision.reason, denied: true };
      }
      if (decision && decision.allow && decision.input) {
        args = decision.input;
      }
    }

    const effective: LlmToolCall = { ...call, arguments: args };
    const started = Date.now();
    let result = await this.executeToolSafely(effective.name, args);
    const durationMs = Date.now() - started;

    for (const mw of this.middleware) {
      const replaced = await mw.after?.({ call: effective, iteration, result, durationMs });
      if (replaced !== undefined) {
        result = replaced;
      }
    }

    result = this.applyLoopGuard(effective, result);
    return capResult(result);
  }

  private async executeToolSafely(name: string, input: unknown): Promise<unknown> {
    try {
      return await this.tools.execute(name, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Unknown tool:")) {
        const names = this.tools.definitions().map((d) => d.name).join(", ");
        return { error: `${message}. Available tools: ${names}` };
      }
      return { error: message };
    }
  }

  /** Warn the model when it keeps issuing the identical call (a doom loop). */
  private applyLoopGuard(call: LlmToolCall, result: unknown): unknown {
    const signature = `${call.name}:${stableStringify(call.arguments)}:${shortHash(stableStringify(result))}`;
    this.recentSignatures.push(signature);
    if (this.recentSignatures.length > 12) {
      this.recentSignatures.shift();
    }

    let streak = 0;
    for (let i = this.recentSignatures.length - 1; i >= 0 && this.recentSignatures[i] === signature; i -= 1) {
      streak += 1;
    }
    if (streak < LOOP_WARN_AT) {
      return result;
    }

    const note =
      streak >= LOOP_STRONG_AT
        ? `You have made this exact call ${streak} times in a row with the same result. STOP repeating it — change your approach (different arguments, a different tool, or re-read the error).`
        : `You have made this exact call ${streak} times in a row with the same result. Try a different approach.`;
    return result !== null && typeof result === "object" && !Array.isArray(result)
      ? { ...(result as Record<string, unknown>), harnessNote: note }
      : { output: result, harnessNote: note };
  }

  private record(event: Omit<TrajectoryEvent, "timestamp">): void {
    this.trajectory.push({ ...event, timestamp: new Date().toISOString() });
  }
}

// --- helpers (exported for tests and reuse) ----------------------------------

/**
 * Split a turn's tool calls into execution segments: each run of contiguous
 * read-only calls becomes one concurrent batch; every mutating call is its own
 * single-element segment. Preserves order and prevents a parallel read from
 * racing a mutating call.
 */
export function segmentToolCalls(
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

/** Short mid-task text that announces an action ("Let me run the tests:") instead of doing it. */
export function looksLikeUnfinishedNarration(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > 500 || /\blet me know\b/i.test(trimmed)) {
    return false;
  }
  if (/:\s*$/.test(trimmed)) {
    return true;
  }
  const lastLine = trimmed.split("\n").filter(Boolean).at(-1) ?? "";
  return /^(?:ok(?:ay)?[,.! ]+)?(?:now,? |next,? |first,? |then,? )?(?:let me|let's|i(?:'ll| will)|i(?:'m| am) going to|i need to)\b/i.test(lastLine);
}

export function isErrorResult(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    typeof (result as Record<string, unknown>).error === "string"
  );
}

/** Models sometimes emit unparseable JSON; the client preserves it under `input`. */
function invalidArgumentsError(call: LlmToolCall): string | undefined {
  const keys = Object.keys(call.arguments);
  if (keys.length === 1 && keys[0] === "input" && typeof call.arguments.input === "string") {
    const preview = call.arguments.input.slice(0, 160).replace(/\s+/g, " ");
    return `The arguments for ${call.name} were not valid JSON (got: "${preview}"). Re-issue the call with a valid JSON object matching the tool schema.`;
  }
  return undefined;
}

function capResult(result: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(result) ?? "";
  } catch {
    return { error: "Tool result could not be serialized." };
  }
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return result;
  }
  const head = serialized.slice(0, Math.floor(MAX_TOOL_RESULT_CHARS * 0.6));
  const tail = serialized.slice(-Math.floor(MAX_TOOL_RESULT_CHARS * 0.3));
  return {
    truncated: true,
    note: `Result was ${serialized.length} chars; showing head and tail. Narrow your query or read a smaller range.`,
    preview: `${head}\n…[${serialized.length - head.length - tail.length} chars omitted]…\n${tail}`,
  };
}

function addUsage(target: LlmUsage, delta?: LlmUsage): void {
  if (!delta) {
    return;
  }
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cachedInputTokens = (target.cachedInputTokens ?? 0) + (delta.cachedInputTokens ?? 0);
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
        : v,
    ) ?? "";
  } catch {
    return String(value);
  }
}

function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

const MAX_TRANSIENT_RETRIES = 3;

/** Failures that arrive after a response has started (so `fetchWithRetry` cannot retry them). */
export function isTransientStreamError(message: string): boolean {
  return /stream interrupted|stream stalled|stream (?:was )?idle|idle timeout|timed? ?out|ECONNRESET|socket hang up|terminated|other side closed|fetch failed|ETIMEDOUT|EPIPE/i.test(message);
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
