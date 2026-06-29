/**
 * Core agent loop.
 *
 * Owns the conversation with the LLM, dispatches tool calls, and
 * renders output to the terminal.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFile } from "node:fs/promises";
import type { CliArgs } from "../cli.js";
import { createLlmClient, type LlmClient, type LlmMessage } from "../llm/client.js";
import { ToolRegistry } from "../tools/index.js";
import { TerminalRenderer } from "../tui/render.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 25;

const SYSTEM_PROMPT =
  "You are RevCode, an AI coding agent. Use the provided tools via function calling only; do not emit raw XML tool markup. " +
  "Prefer the smallest number of tool calls needed. Use list_directory before read_file when paths are unknown. " +
  "Use grep for content search and glob for file discovery instead of reading many files or using shell find/ls. " +
  "When writing scripts or files, write the complete content in one write_file call, then run it with shell if needed. " +
  "Explain results concisely.";

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
  private readonly llm: LlmClient;
  private readonly tools: ToolRegistry;
  private readonly renderer: TerminalRenderer;
  private readonly trajectory: TrajectoryEvent[] = [];

  constructor(args: CliArgs) {
    this.args = args;
    this.llm = createLlmClient({
      model: args.model,
      provider: args.provider,
    });
    this.tools = new ToolRegistry({ cwd: args.cwd });
    this.renderer = new TerminalRenderer();
  }

  async start(): Promise<void> {
    if (this.args.headless) {
      const instruction = await this.resolveHeadlessInstruction();
      const result = await this.runTask(instruction);
      if (result.finalContent) {
        console.log(`\n${result.finalContent}\n`);
      }
      await this.writeTrajectory();
      return;
    }

    this.renderer.welcome();

    const rl = createInterface({ input, output });
    const messages = this.createInitialMessages();

    try {
      rl.setPrompt("> ");
      if (input.isTTY) {
        rl.prompt();
      }

      for await (const userInput of rl) {
        if (shouldExit(userInput)) {
          break;
        }

        if (handleSlashCommand(userInput, messages, this.tools)) {
          if (input.isTTY) {
            rl.prompt();
          }
          continue;
        }

        messages.push({ role: "user", content: userInput });
        await this.completeWithTools(messages);
        if (input.isTTY) {
          rl.prompt();
        }
      }
    } finally {
      rl.close();
    }

    this.renderer.goodbye();
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
      content: SYSTEM_PROMPT,
    });

    return [{ role: "system", content: SYSTEM_PROMPT }];
  }

  private async completeWithTools(messages: LlmMessage[]): Promise<string> {
    const toolDefinitions = this.tools.definitions();
    const maxIterations = this.args.maxIterations || DEFAULT_MAX_TOOL_ITERATIONS;
    let finalContent = "";

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const response = await this.llm.complete(messages, toolDefinitions);
      finalContent = response.content;

      if (response.content) {
        console.log(`\n${response.content}\n`);
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

      for (const toolCall of response.toolCalls) {
        console.log(`[${toolCall.name}(${JSON.stringify(toolCall.arguments)})]`);
        this.recordTrajectory({
          type: "tool_call",
          timestamp: nowIso(),
          name: toolCall.name,
          arguments: toolCall.arguments,
          toolCallId: toolCall.id,
        });

        const result = await this.executeToolSafely(toolCall.name, toolCall.arguments);
        this.recordTrajectory({
          type: "tool_result",
          timestamp: nowIso(),
          name: toolCall.name,
          result,
          toolCallId: toolCall.id,
        });

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify({
            toolCallId: toolCall.id,
            name: toolCall.name,
            result,
          }),
        });
      }
    }

    console.log(`Stopped after ${maxIterations} tool iterations.`);
    return finalContent;
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

function shouldExit(userInput: string): boolean {
  const normalized = userInput.trim().toLowerCase();
  return normalized === "/exit" || normalized === "/quit" || normalized === "exit";
}

function handleSlashCommand(
  command: string,
  messages: LlmMessage[],
  tools: ToolRegistry,
): boolean {
  const trimmed = command.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }

  const [name] = trimmed.split(/\s+/, 1);

  switch (name.toLowerCase()) {
    case "/help":
      console.log(
        [
          "/memory  — show full message history sent to the LLM",
          "/tools   — show tool JSON schemas",
          "/clear   — reset conversation to system prompt only",
          "/help    — show this help",
          "/exit    — quit",
        ].join("\n"),
      );
      return true;
    case "/memory":
      console.log(JSON.stringify(messages, null, 2));
      return true;
    case "/tools":
      console.log(JSON.stringify(tools.definitions(), null, 2));
      return true;
    case "/clear":
      messages.splice(0, messages.length, { role: "system", content: SYSTEM_PROMPT });
      console.log("Conversation cleared.");
      return true;
    default:
      console.log(`Unknown command: ${name}. Type /help for available commands.`);
      return true;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
