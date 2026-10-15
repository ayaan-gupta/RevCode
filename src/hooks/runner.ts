/**
 * HookRunner — executes user-configured lifecycle hooks and adapts them to the
 * engine's extension points ({@link ToolMiddleware} for tool hooks,
 * {@link FinalGate} for Stop).
 *
 * Contract with hook commands (same as Claude Code):
 *  - the event JSON arrives on stdin;
 *  - exit 0: success. stdout is parsed as a JSON decision when it is an
 *    object; otherwise, for UserPromptSubmit / SessionStart, it is added to the
 *    model's context as plain text;
 *  - exit 2: BLOCK. stderr is the reason shown to the model (veto a tool,
 *    reject a prompt, or refuse to let the model stop);
 *  - any other exit: a non-blocking warning.
 *
 * Hooks are user code, so nothing here may take the agent down: every failure
 * (spawn error, timeout, garbage output) degrades to a string in
 * {@link HookRunner.warnings}. Matching hooks for one event run sequentially in
 * config order and stop at the first block, so an input rewritten by one
 * PreToolUse hook is what the next one sees.
 */

import type { FinalGate, ToolCallContext, ToolDecision, ToolMiddleware } from "../agent/engine.js";
import type { LlmToolCall } from "../llm/client.js";
import {
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  HOOK_EVENTS,
  loadHooksConfig,
  matcherMatches,
  type HookCommandSpec,
  type HookEvent,
  type HooksConfig,
  type LoadHooksOptions,
} from "./config.js";
import { runHookProcess, type HookProcessResult } from "./exec.js";

export type PermissionDecision = "allow" | "deny" | "ask";

export interface HookRunnerOptions {
  /** Project directory: hook working directory and `REVCODE_PROJECT_DIR`. */
  cwd: string;
  sessionId: string;
  /** Config-load warnings to surface through {@link HookRunner.warnings}. */
  warnings?: readonly string[];
  /** Called synchronously for each warning so the UI can print it immediately. */
  onWarning?: (message: string) => void;
}

export interface UserPromptResult {
  /** Set when a hook rejected the prompt; show it to the user and do not run the turn. */
  blocked?: string;
  /** Extra context to give the model alongside the prompt. */
  context?: string;
}

/** Consecutive-turn safety net against a Stop hook that never says "done". */
export const MAX_STOP_CONTINUATIONS = 3;
const MAX_WARNINGS = 200;
const MAX_REASON_CHARS = 4_000;
/** Pre-tool evaluations kept for the permission layer; calls that are denied never reach `after`. */
const MAX_TRACKED_CALLS = 256;

const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "PostToolUse"]);
/** Events where plain-text stdout is context for the model. */
const CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(["UserPromptSubmit", "SessionStart"]);

/** What one hook command asked for, after interpreting its exit code and stdout. */
interface HookResult {
  /** Veto reason: exit 2, `decision:"block"`, or `permissionDecision:"deny"`. */
  block?: string;
  permission?: PermissionDecision;
  updatedInput?: Record<string, unknown>;
  /** `additionalContext`, or plain stdout for context events. */
  context?: string;
}

interface PreEvaluation {
  block?: string;
  permission?: PermissionDecision;
  input: Record<string, unknown>;
  updated: boolean;
  context: string[];
  /** Serialized original arguments, to recognize the same call when `before` picks up a prefetch. */
  argsKey: string;
  /** Computed ahead of `before` by {@link HookRunner.permissionDecisionFor}; `before` must reuse it, not re-run hooks. */
  prefetched: boolean;
}

export class HookRunner {
  /** Every problem hooks have had (bad config, timeouts, non-blocking failures), oldest first. */
  readonly warnings: string[] = [];

  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly onWarning?: (message: string) => void;
  private readonly evaluations = new Map<string, PreEvaluation>();
  private stopContinuations = 0;
  private stopHookActive = false;
  private stopCapReported = false;

  constructor(
    private readonly config: HooksConfig,
    options: HookRunnerOptions,
  ) {
    this.cwd = options.cwd;
    this.sessionId = options.sessionId;
    this.onWarning = options.onWarning;
    for (const message of options.warnings ?? []) {
      this.warn(message);
    }
  }

  /** Read the global, project, and project-local hook files for `cwd`. */
  static load(
    cwd: string,
    sessionId: string,
    options: LoadHooksOptions & { onWarning?: (message: string) => void } = {},
  ): HookRunner {
    const { onWarning, ...loadOptions } = options;
    const loaded = loadHooksConfig(cwd, loadOptions);
    return new HookRunner(loaded.config, {
      cwd,
      sessionId,
      warnings: loaded.warnings,
      ...(onWarning ? { onWarning } : {}),
    });
  }

  /** Every configured hook, for display. */
  summary(): Array<{ event: HookEvent; matcher: string; command: string; timeout?: number }> {
    const out: Array<{ event: HookEvent; matcher: string; command: string; timeout?: number }> = [];
    for (const event of HOOK_EVENTS) {
      for (const group of this.config[event] ?? []) {
        for (const hook of group.hooks) {
          out.push({ event, matcher: group.matcher && group.matcher !== "" ? group.matcher : "*", command: hook.command, ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}) });
        }
      }
    }
    return out;
  }

  hasHooks(event: HookEvent): boolean {
    return (this.config[event] ?? []).some((group) => group.hooks.length > 0);
  }

  async runUserPromptSubmit(prompt: string): Promise<UserPromptResult> {
    const contexts: string[] = [];
    for (const spec of this.select("UserPromptSubmit")) {
      const result = await this.runOne("UserPromptSubmit", spec, { prompt });
      if (result.context) {
        contexts.push(result.context);
      }
      if (result.block) {
        return { blocked: result.block, ...(contexts.length > 0 ? { context: contexts.join("\n") } : {}) };
      }
    }
    return contexts.length > 0 ? { context: contexts.join("\n") } : {};
  }

  /** Run SessionStart hooks; returns context to add to the conversation, if any. */
  async runSessionStart(): Promise<string | undefined> {
    const contexts: string[] = [];
    for (const spec of this.select("SessionStart")) {
      const result = await this.runOne("SessionStart", spec, { source: "startup" });
      if (result.context) {
        contexts.push(result.context);
      }
      if (result.block) {
        // There is nothing to veto at session start; do not lose the message.
        this.warn(`SessionStart hook \`${shorten(spec.command)}\` exited 2: ${result.block}`);
      }
    }
    return contexts.length > 0 ? contexts.join("\n") : undefined;
  }

  /**
   * PreToolUse / PostToolUse as engine middleware. Register it before the
   * permission middleware so approvals see any `updatedInput`.
   */
  toMiddleware(): ToolMiddleware {
    return {
      name: "hooks",
      before: async (ctx: ToolCallContext): Promise<ToolDecision | void> => {
        const cached = this.evaluations.get(ctx.call.id);
        const reusable = cached?.prefetched === true && cached.argsKey === argsKey(ctx.call.arguments);
        const evaluation = reusable ? cached : await this.evaluatePreToolUse(ctx.call, false);
        evaluation.prefetched = false;
        if (evaluation.block !== undefined) {
          return { allow: false, reason: evaluation.block };
        }
        return evaluation.updated ? { allow: true, input: evaluation.input } : { allow: true };
      },
      after: async (ctx): Promise<unknown> => {
        const pre = this.evaluations.get(ctx.call.id);
        this.evaluations.delete(ctx.call.id);

        const feedback = [...(pre?.context ?? [])];
        for (const spec of this.select("PostToolUse", ctx.call.name)) {
          const result = await this.runOne("PostToolUse", spec, {
            tool_name: ctx.call.name,
            tool_input: ctx.call.arguments,
            tool_response: ctx.result,
            tool_use_id: ctx.call.id,
          });
          // The tool already ran, so a "block" here is feedback for the model, not a veto.
          if (result.block) feedback.push(result.block);
          if (result.context) feedback.push(result.context);
        }
        return feedback.length > 0 ? withFeedback(ctx.result, feedback.join("\n")) : undefined;
      },
    };
  }

  /**
   * Stop hooks as a final gate: a block sends the model back to work. After
   * {@link MAX_STOP_CONTINUATIONS} forced continuations the hooks are no longer
   * consulted (and a warning is recorded) so a hook that is never satisfied
   * cannot loop the agent forever. Call {@link resetStopContinuations} at the
   * start of each user turn to give every turn its own budget.
   */
  toFinalGate(): FinalGate {
    return {
      name: "hooks:stop",
      check: async (): Promise<string | undefined> => {
        if (!this.hasHooks("Stop")) {
          return undefined;
        }
        if (this.stopContinuations >= MAX_STOP_CONTINUATIONS) {
          if (!this.stopCapReported) {
            this.stopCapReported = true;
            this.warn(
              `Stop hooks asked the model to continue ${MAX_STOP_CONTINUATIONS} times; allowing it to stop without consulting them again`,
            );
          }
          return undefined;
        }

        for (const spec of this.select("Stop")) {
          const result = await this.runOne("Stop", spec, { stop_hook_active: this.stopHookActive });
          if (result.block) {
            this.stopContinuations += 1;
            this.stopHookActive = true;
            return `A Stop hook says you are not done yet: ${result.block}`;
          }
        }
        this.stopHookActive = false;
        return undefined;
      },
    };
  }

  /** Give the Stop gate a fresh continuation budget (call at the start of each user turn). */
  resetStopContinuations(): void {
    this.stopContinuations = 0;
    this.stopHookActive = false;
    this.stopCapReported = false;
  }

  /**
   * What PreToolUse hooks decided about permission for this call, for a
   * permission layer to consult: `deny` (also set for any block), `ask`
   * (the user must be prompted, never auto-approve), `allow` (skip the prompt),
   * or undefined when no hook expressed an opinion. Hooks run at most once per
   * call: if the middleware already evaluated it the cached result is used, and
   * if this runs first the middleware reuses what it computed.
   */
  async permissionDecisionFor(call: LlmToolCall): Promise<PermissionDecision | undefined> {
    const evaluation = this.evaluations.get(call.id) ?? (await this.evaluatePreToolUse(call, true));
    return evaluation.permission;
  }

  /**
   * Synchronous variant for a permission middleware registered after
   * {@link toMiddleware}: the hooks' `before` has already run for this call.
   */
  lastPermissionDecision(toolCallId: string): PermissionDecision | undefined {
    return this.evaluations.get(toolCallId)?.permission;
  }

  // --- internals ----------------------------------------------------------------

  private async evaluatePreToolUse(call: LlmToolCall, prefetched: boolean): Promise<PreEvaluation> {
    const evaluation: PreEvaluation = {
      input: call.arguments,
      updated: false,
      context: [],
      argsKey: argsKey(call.arguments),
      prefetched,
    };
    for (const spec of this.select("PreToolUse", call.name)) {
      const result = await this.runOne("PreToolUse", spec, {
        tool_name: call.name,
        tool_input: evaluation.input,
        tool_use_id: call.id,
      });
      if (result.updatedInput) {
        evaluation.input = result.updatedInput;
        evaluation.updated = true;
      }
      if (result.context) {
        evaluation.context.push(result.context);
      }
      evaluation.permission = strictest(evaluation.permission, result.permission);
      if (result.block !== undefined) {
        evaluation.block = result.block;
        evaluation.permission = "deny";
        break;
      }
    }

    this.evaluations.set(call.id, evaluation);
    if (this.evaluations.size > MAX_TRACKED_CALLS) {
      const oldest = this.evaluations.keys().next();
      if (!oldest.done) {
        this.evaluations.delete(oldest.value);
      }
    }
    return evaluation;
  }

  /** Hooks for `event`, in config order. Matchers only apply to tool events. */
  private select(event: HookEvent, toolName?: string): HookCommandSpec[] {
    return (this.config[event] ?? [])
      .filter((group) => !TOOL_EVENTS.has(event) || toolName === undefined || matcherMatches(group.matcher, toolName))
      .flatMap((group) => group.hooks);
  }

  /** Run one hook command. Never throws. */
  private async runOne(
    event: HookEvent,
    spec: HookCommandSpec,
    fields: Record<string, unknown>,
  ): Promise<HookResult> {
    const timeoutSeconds = spec.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS;
    try {
      const proc = await runHookProcess(spec.command, {
        cwd: this.cwd,
        env: { ...process.env, REVCODE_PROJECT_DIR: this.cwd, REVCODE_HOOK_EVENT: event },
        input: this.serialize(event, fields),
        timeoutMs: timeoutSeconds * 1000,
      });
      const interpreted = interpret(event, spec.command, timeoutSeconds, proc);
      for (const warning of interpreted.warnings) {
        this.warn(warning);
      }
      return interpreted.result;
    } catch (error) {
      this.warn(`${describe(event, spec.command)} failed unexpectedly: ${errorMessage(error)}`);
      return {};
    }
  }

  private serialize(event: HookEvent, fields: Record<string, unknown>): string {
    const envelope = { hook_event_name: event, session_id: this.sessionId, cwd: this.cwd, ...fields };
    try {
      return JSON.stringify(envelope);
    } catch {
      // A tool result that cannot be serialized (cycle, BigInt) must not cost the hook its event.
      return JSON.stringify({ ...envelope, tool_input: undefined, tool_response: "[unserializable]" });
    }
  }

  private warn(message: string): void {
    if (this.warnings.length < MAX_WARNINGS) {
      this.warnings.push(message);
    }
    try {
      this.onWarning?.(message);
    } catch {
      // A broken UI callback must not break the agent.
    }
  }
}

// --- result interpretation ----------------------------------------------------------

function interpret(
  event: HookEvent,
  command: string,
  timeoutSeconds: number,
  proc: HookProcessResult,
): { result: HookResult; warnings: string[] } {
  const label = describe(event, command);

  if (proc.spawnError !== undefined) {
    return { result: {}, warnings: [`${label} could not start: ${proc.spawnError}`] };
  }
  if (proc.timedOut) {
    return { result: {}, warnings: [`${label} timed out after ${timeoutSeconds}s and was killed`] };
  }
  if (proc.exitCode === 2) {
    const reason = proc.stderr.trim() || proc.stdout.trim() || `Blocked by ${label}`;
    return { result: { block: clip(reason) }, warnings: [] };
  }
  if (proc.exitCode !== 0) {
    const how = proc.exitCode === null ? `was killed by ${proc.signal ?? "a signal"}` : `exited with code ${proc.exitCode}`;
    const detail = firstLine(proc.stderr) ?? firstLine(proc.stdout);
    return { result: {}, warnings: [`${label} ${how}${detail ? `: ${detail}` : ""}`] };
  }

  const output = proc.stdout.trim();
  const json = parseJsonObject(output);
  if (json) {
    return interpretJson(label, json);
  }

  const warnings = output.startsWith("{") ? [`${label} printed output that looks like JSON but does not parse`] : [];
  return { result: CONTEXT_EVENTS.has(event) && output !== "" ? { context: clip(output) } : {}, warnings };
}

function interpretJson(label: string, json: Record<string, unknown>): { result: HookResult; warnings: string[] } {
  const result: HookResult = {};
  const warnings: string[] = [];
  const specific = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
  const reason = nonEmpty(json.reason);

  if (json.decision === "block") {
    result.block = clip(reason ?? `Blocked by ${label}`);
  }

  // `decision: "approve"` is the legacy PreToolUse spelling of permissionDecision "allow".
  const permission = specific.permissionDecision ?? (json.decision === "approve" ? "allow" : undefined);
  if (permission === "allow" || permission === "deny" || permission === "ask") {
    result.permission = permission;
    if (permission === "deny" && result.block === undefined) {
      result.block = clip(nonEmpty(specific.permissionDecisionReason) ?? reason ?? `Denied by ${label}`);
    }
  } else if (permission !== undefined) {
    warnings.push(`${label} returned an unknown permissionDecision ${JSON.stringify(permission)}; ignoring it`);
  }

  if (specific.updatedInput !== undefined) {
    if (isRecord(specific.updatedInput)) {
      result.updatedInput = specific.updatedInput;
    } else {
      warnings.push(`${label} returned updatedInput that is not an object; ignoring it`);
    }
  }

  const context = nonEmpty(specific.additionalContext);
  if (context) {
    result.context = clip(context);
  }
  return { result, warnings };
}

/** Keep the model-facing shape stable: objects gain a field, anything else is wrapped. */
function withFeedback(result: unknown, hookFeedback: string): unknown {
  return isRecord(result) ? { ...result, hookFeedback } : { output: result, hookFeedback };
}

const PERMISSION_RANK: Record<PermissionDecision, number> = { allow: 1, ask: 2, deny: 3 };

/** Combine opinions conservatively: any deny wins, then ask, then allow. */
function strictest(
  current: PermissionDecision | undefined,
  next: PermissionDecision | undefined,
): PermissionDecision | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return PERMISSION_RANK[next] > PERMISSION_RANK[current] ? next : current;
}

function argsKey(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function describe(event: HookEvent, command: string): string {
  return `${event} hook \`${shorten(command)}\``;
}

function shorten(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}

function clip(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}\n…[truncated]` : text;
}

function firstLine(text: string): string | undefined {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return line?.trim().slice(0, 200);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
