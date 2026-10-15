/**
 * Permission layer.
 *
 * Modes:
 *   ask           prompt before edits and non-trivial shell commands (interactive default)
 *   accept-edits  file edits are automatic; shell still asks
 *   plan          read-only: nothing that mutates runs
 *   yolo          no prompts (headless default, and inside disposable Universes)
 *
 * Independent of mode: deny rules always win, and a short list of catastrophic
 * shell commands (rm -rf /, mkfs, dd to a block device, fork bombs…) is refused.
 * Rules look like `shell(git status*)`, `edit_file(src/**)`, or `mcp__github__*`.
 */

import type { ToolCallContext, ToolDecision, ToolMiddleware } from "./engine.js";
import { classifyShellCommand, commandPrefix } from "./shell-classify.js";

export type PermissionMode = "ask" | "accept-edits" | "plan" | "yolo";
export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "accept-edits", "plan", "yolo"];

export type ApprovalAnswer = "allow" | "deny" | "always";

/** A richer answer: a denial can carry the user's own words about what to do instead. */
export interface ApprovalDecision {
  answer: ApprovalAnswer;
  feedback?: string;
}

export interface ApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
  /** One-line human description (the command, or the target path). */
  summary: string;
  /** Why we are asking. */
  reason: string;
  /** What choosing "always" would allow, worded for a menu option. */
  alwaysLabel?: string;
}

export type Approver = (request: ApprovalRequest) => Promise<ApprovalAnswer | ApprovalDecision>;

export interface PermissionOptions {
  mode: PermissionMode;
  allow?: string[];
  deny?: string[];
  approver?: Approver;
  /** Tools that never need approval (read-only built-ins and read-only MCP tools). */
  isReadOnly?: (toolName: string) => boolean;
  /**
   * What a PreToolUse hook said about this call: "ask" forces a prompt even if
   * rules or the mode would allow it; "allow" waives the prompt. Never overrides
   * deny rules, plan mode, or the catastrophic-command refusal.
   */
  hookDecision?: (callId: string) => "allow" | "deny" | "ask" | undefined;
  /** Called when the user chose "don't ask again": a chance to persist the new allow rule. */
  onRuleAdded?: (rule: string) => void;
}

export type Evaluation =
  | { action: "allow"; reason?: string }
  | { action: "deny"; reason: string }
  | { action: "ask"; reason: string; summary: string };

const EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "edit_anchored", "delete_file"]);
const ALWAYS_ALLOWED = new Set(["update_plan", "use_skill", "task"]);

export class PermissionManager {
  private mode: PermissionMode;
  private readonly allowRules: string[];
  private readonly denyRules: string[];
  private approver?: Approver;
  private readonly isReadOnly: (toolName: string) => boolean;
  private readonly hookDecision?: PermissionOptions["hookDecision"];
  private readonly onRuleAdded?: PermissionOptions["onRuleAdded"];
  /** Serializes prompts so two approvals never fight over the terminal. */
  private promptQueue: Promise<unknown> = Promise.resolve();

  constructor(options: PermissionOptions) {
    this.mode = options.mode;
    this.allowRules = [...(options.allow ?? [])];
    this.denyRules = [...(options.deny ?? [])];
    this.approver = options.approver;
    this.isReadOnly = options.isReadOnly ?? (() => false);
    this.hookDecision = options.hookDecision;
    this.onRuleAdded = options.onRuleAdded;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  setApprover(approver: Approver | undefined): void {
    this.approver = approver;
  }

  rules(): { allow: string[]; deny: string[] } {
    return { allow: [...this.allowRules], deny: [...this.denyRules] };
  }

  addDenyRule(rule: string): void {
    if (!this.denyRules.includes(rule)) {
      this.denyRules.push(rule);
    }
  }

  addAllowRule(rule: string): void {
    if (!this.allowRules.includes(rule)) {
      this.allowRules.push(rule);
    }
  }

  /** Pure decision for a tool call (no side effects, no prompting). */
  evaluate(tool: string, args: Record<string, unknown>): Evaluation {
    const subject = ruleSubjects(tool, args);

    const denied = this.denyRules.find((rule) => ruleMatches(rule, tool, subject, "any"));
    if (denied) {
      return { action: "deny", reason: `Denied by permission rule "${denied}".` };
    }

    if (tool === "shell") {
      const command = String(args.command ?? "");
      if (classifyShellCommand(command) === "catastrophic") {
        return {
          action: "deny",
          reason: "Refused: this command could destroy the system or its data. RevCode blocks it in every mode.",
        };
      }
    }

    if (this.mode === "plan") {
      if (this.isReadOnly(tool) || ALWAYS_ALLOWED.has(tool)) {
        return { action: "allow" };
      }
      if (tool === "shell" && classifyShellCommand(String(args.command ?? "")) === "safe") {
        return { action: "allow" };
      }
      return {
        action: "deny",
        reason:
          "Plan mode is read-only: this action would change things. Finish your investigation, present the plan to the user, and wait for them to leave plan mode.",
      };
    }

    const allowedBy = this.allowRules.find((rule) => ruleMatches(rule, tool, subject, "all"));
    if (allowedBy) {
      return { action: "allow", reason: `allowed by rule "${allowedBy}"` };
    }
    if (this.isReadOnly(tool) || ALWAYS_ALLOWED.has(tool)) {
      return { action: "allow" };
    }
    if (this.mode === "yolo") {
      return { action: "allow" };
    }

    if (EDIT_TOOLS.has(tool)) {
      return this.mode === "accept-edits"
        ? { action: "allow" }
        : { action: "ask", reason: "Modifies files.", summary: `${tool} ${String(args.path ?? "")}`.trim() };
    }

    if (tool === "shell") {
      const command = String(args.command ?? "");
      if (classifyShellCommand(command) === "safe") {
        return { action: "allow" };
      }
      return { action: "ask", reason: "Runs a shell command.", summary: command };
    }

    if (tool === "terminal") {
      const detail = String(args.command ?? args.text ?? args.action ?? "");
      return { action: "ask", reason: "Drives an interactive program.", summary: `terminal ${String(args.action ?? "")} ${truncate(detail, 100)}`.trim() };
    }

    return { action: "ask", reason: `Uses the ${tool} tool.`, summary: `${tool} ${truncate(JSON.stringify(args), 120)}` };
  }

  middleware(): ToolMiddleware {
    return {
      name: "permissions",
      before: (ctx) => this.decide(ctx),
    };
  }

  private async decide({ call }: ToolCallContext): Promise<ToolDecision> {
    let evaluation = this.evaluate(call.name, call.arguments);
    const hook = this.hookDecision?.(call.id);
    if (hook === "ask" && evaluation.action === "allow" && this.mode !== "plan" && !this.isReadOnly(call.name)) {
      evaluation = {
        action: "ask",
        reason: "A hook requires confirmation.",
        summary: call.name === "shell" ? String(call.arguments.command ?? "") : `${call.name} ${String(call.arguments.path ?? "")}`.trim(),
      };
    } else if (hook === "allow" && evaluation.action === "ask") {
      evaluation = { action: "allow", reason: "allowed by a hook" };
    }
    if (evaluation.action === "allow") {
      return { allow: true };
    }
    if (evaluation.action === "deny") {
      return { allow: false, reason: evaluation.reason };
    }

    if (!this.approver) {
      return {
        allow: false,
        reason: `${evaluation.reason} Approval is required but this session is non-interactive. Re-run with --yolo (or --mode accept-edits) to allow it.`,
      };
    }

    const approver = this.approver;
    const raw = await this.enqueue(() =>
      approver({
        tool: call.name,
        args: call.arguments,
        summary: evaluation.summary,
        reason: evaluation.reason,
        alwaysLabel: this.alwaysLabel(call.name, call.arguments),
      }),
    );
    const decision: ApprovalDecision = typeof raw === "string" ? { answer: raw } : raw;

    if (decision.answer === "deny") {
      const said = decision.feedback?.trim();
      return {
        allow: false,
        reason: said
          ? `The user declined this action and said: "${said}". Do not retry it as written; follow their guidance.`
          : "The user declined this action. Do not retry it; ask what they would prefer instead.",
      };
    }
    if (decision.answer === "always") {
      if (EDIT_TOOLS.has(call.name)) {
        // "Allow all edits this session" is exactly what accept-edits mode means.
        if (this.mode === "ask") this.mode = "accept-edits";
      } else {
        const rule = call.name === "shell" ? `shell(${commandPrefix(String(call.arguments.command ?? ""))}*)` : call.name;
        this.addAllowRule(rule);
        this.onRuleAdded?.(rule);
      }
    }
    return { allow: true };
  }

  private alwaysLabel(tool: string, args: Record<string, unknown>): string {
    if (EDIT_TOOLS.has(tool)) return "Yes, and allow all edits this session";
    if (tool === "shell") return `Yes, and don't ask again for \`${commandPrefix(String(args.command ?? ""))}*\` in this project`;
    return `Yes, and don't ask again for ${tool} in this project`;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.promptQueue.then(task, task);
    this.promptQueue = run.catch(() => undefined);
    return run;
  }
}

// --- rules -------------------------------------------------------------------

/**
 * What a rule's `(pattern)` is matched against for this tool call. A call can touch
 * several files (apply_patch), so this is a list: a DENY rule fires if ANY subject
 * matches, an ALLOW rule only if ALL of them do.
 */
function ruleSubjects(tool: string, args: Record<string, unknown>): string[] {
  if (tool === "shell") return typeof args.command === "string" ? [args.command] : [];
  if (tool === "apply_patch") {
    const text = String(args.input ?? args.patch ?? "");
    return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm), ...text.matchAll(/^\*\*\* Move to: (.+)$/gm)].map((m) => m[1].trim());
  }
  if (typeof args.path === "string") return [args.path];
  return [];
}

/**
 * The file-editing tools are one family: a rule written for `edit_file(src/secret*)`
 * must also stop `apply_patch` or `write_file` from touching those files, or it is
 * trivially bypassed by picking a different tool.
 */
function sameToolFamily(rulePattern: string, tool: string): boolean {
  if (!EDIT_TOOLS.has(tool)) return false;
  return [...EDIT_TOOLS].some((editTool) => globToRegExp(rulePattern.trim()).test(editTool));
}

export function ruleMatches(rule: string, tool: string, subject: string | string[] | undefined, mode: "any" | "all" = "any"): boolean {
  const match = /^([^()]+?)(?:\((.*)\))?$/.exec(rule.trim());
  if (!match) {
    return false;
  }
  const [, toolPattern, subjectPattern] = match;
  if (!globToRegExp(toolPattern.trim()).test(tool) && !sameToolFamily(toolPattern, tool)) {
    return false;
  }
  if (subjectPattern === undefined || subjectPattern === "") {
    return true;
  }
  const subjects = subject === undefined ? [] : Array.isArray(subject) ? subject : [subject];
  if (subjects.length === 0) {
    return false;
  }
  const matcher = globToRegExp(subjectPattern);
  return mode === "all" ? subjects.every((s) => matcher.test(s)) : subjects.some((s) => matcher.test(s));
}

/** `*` and `**` both match any run of characters (including `/`); `?` matches one. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*+/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
