/**
 * `task` tool: delegate an investigation to a read-only subagent.
 *
 * The subagent gets a fresh context, can read/search/run read-only commands, and
 * returns a single report. That keeps noisy exploration (dozens of file reads)
 * out of the main conversation — the main reason subagents exist — while being
 * safe to run in parallel because nothing it does can modify anything.
 */

import type { LlmClient } from "../llm/client.js";
import type { HarnessProfile } from "../harness/profile.js";
import { withProfile } from "../harness/profile.js";
import { buildSystemPrompt } from "../harness/prompt.js";
import { ToolRegistry, type RegisteredTool } from "../tools/index.js";
import { AgentEngine } from "./engine.js";
import { PermissionManager } from "./permissions.js";

export const TASK_TOOL_NAME = "task";
const SUBAGENT_TOOLS = ["read_file", "list_directory", "grep", "glob", "shell"] as const;
const SUBAGENT_MAX_ITERATIONS = 40;

export interface SubagentContext {
  cwd: string;
  llm: () => LlmClient;
  profile: HarnessProfile;
  unrestrictedPaths: boolean;
  /** Called with a short progress line (shown in the UI). */
  notice?: (message: string) => void;
}

export function createTaskTool(context: SubagentContext): RegisteredTool {
  return {
    definition: {
      name: TASK_TOOL_NAME,
      description:
        "Delegate a self-contained investigation to a read-only subagent with its own fresh context, and get back one concise report. Use it for broad exploration (finding where something is implemented, tracing a code path, surveying many files) so the noise stays out of your context. The subagent can read, search, and run read-only commands; it cannot modify anything. Give it a complete, specific prompt — it cannot see this conversation. Several task calls in one turn run in parallel.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short (3-6 word) label for the investigation." },
          prompt: {
            type: "string",
            description: "Everything the subagent needs: the question, relevant paths, and what the report should contain.",
          },
        },
        required: ["description", "prompt"],
        additionalProperties: false,
      },
    },
    handler: async (input) => {
      const args = (input ?? {}) as Record<string, unknown>;
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      const description = typeof args.description === "string" ? args.description.trim() : "investigation";
      if (!prompt) {
        throw new Error("task requires a non-empty prompt");
      }
      return runSubagent(context, description, prompt);
    },
  };
}

async function runSubagent(context: SubagentContext, description: string, prompt: string): Promise<unknown> {
  const profile = withProfile(context.profile, { promptStyle: "terse", editMode: "whole", parallelTools: true });
  const tools = new ToolRegistry({ cwd: context.cwd, profile, unrestrictedPaths: context.unrestrictedPaths });
  tools.restrictTo(SUBAGENT_TOOLS);

  const permissions = new PermissionManager({ mode: "plan", isReadOnly: (name) => tools.isReadOnly(name) });
  const systemPrompt = buildSystemPrompt({
    cwd: context.cwd,
    profile,
    mode: "headless",
    extraSections: [
      "# Your role\nYou are a read-only research subagent. Investigate the question you are given using the tools, then reply with a single concise report: findings first, with file paths and line numbers as evidence, and any uncertainty stated plainly. You cannot modify files or run mutating commands. Do not ask questions.",
    ],
  });

  const engine = new AgentEngine({
    cwd: context.cwd,
    llm: context.llm(),
    profile,
    systemPrompt,
    tools,
    maxIterations: SUBAGENT_MAX_ITERATIONS,
    middleware: [permissions.middleware()],
  });

  context.notice?.(`subagent started: ${description}`);
  try {
    const result = await engine.runTurn(prompt);
    const report = result.finalContent.trim();
    return {
      report: report || "(the subagent returned no report)",
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      durationMs: result.durationMs,
      ...(result.stopReason !== "complete" ? { note: `The subagent stopped early (${result.stopReason}); its report may be partial.` } : {}),
    };
  } finally {
    tools.dispose();
  }
}
