/**
 * Core agent loop.
 *
 * Owns the conversation with the LLM, dispatches tool calls, and
 * renders output to the terminal.
 */

import { stdin as input, stdout as output } from "node:process";
import { writeFile } from "node:fs/promises";
import type { CliArgs } from "../cli.js";
import { createLlmClient, type LlmClient, type LlmMessage } from "../llm/client.js";
import { ToolRegistry } from "../tools/index.js";
import { readBoxedInput } from "../tui/input.js";
import { TerminalRenderer } from "../tui/render.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 25;

const SUGGESTED_GLM_MODELS = ["glm-5.2", "glm-4.7", "glm-4.7-flash"] as const;

const SYSTEM_PROMPT =
  "You are RevCode, an AI coding agent. Use the provided tools via function calling only; do not emit raw XML tool markup. " +
  "Prefer the smallest number of tool calls needed. Use list_directory before read_file when paths are unknown. " +
  "Use grep for content search and glob for file discovery instead of reading many files or using shell find/ls. " +
  "When writing scripts or files, write the complete content in one write_file call, then run it with shell if needed. " +
  "Use exact field names, paths, and identifiers from the task instruction verbatim (e.g. protobuf field names). " +
  "When all requested steps are done, reply with a brief summary and do not call more tools. " +
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
  private llm: LlmClient;
  private readonly tools: ToolRegistry;
  private readonly renderer: TerminalRenderer;
  private readonly interactive: boolean;
  private currentModel: string;
  private readonly trajectory: TrajectoryEvent[] = [];

  constructor(args: CliArgs) {
    this.args = args;
    this.interactive = !args.headless;
    this.currentModel = args.model;
    this.llm = createLlmClient({
      model: args.model,
      provider: args.provider,
    });
    this.tools = new ToolRegistry({ cwd: args.cwd });
    this.renderer = new TerminalRenderer(args, output.isTTY);
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
    }

    this.renderer.goodbye();
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
      content: SYSTEM_PROMPT,
    });

    return [{ role: "system", content: SYSTEM_PROMPT }];
  }

  private async completeWithTools(messages: LlmMessage[]): Promise<string> {
    const toolDefinitions = this.tools.definitions();
    const maxIterations = this.args.maxIterations || DEFAULT_MAX_TOOL_ITERATIONS;
    let finalContent = "";
    let spinner = this.interactive ? this.renderer.startThinking() : undefined;

    try {
      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const response = await this.llm.complete(messages, toolDefinitions);
        finalContent = response.content;

        if (response.content) {
          if (this.interactive) {
            spinner?.stop();
            spinner = undefined;
            this.renderer.assistant(response.content);
          } else {
            console.log(`\n${response.content}\n`);
          }
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

        if (this.interactive) {
          spinner?.stop();
          spinner = undefined;
        }

        for (const toolCall of response.toolCalls) {
          if (this.interactive) {
            this.renderer.toolCall(toolCall.name, toolCall.arguments);
          } else {
            console.log(`[${toolCall.name}(${JSON.stringify(toolCall.arguments)})]`);
          }
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

        if (this.interactive && iteration + 1 < maxIterations) {
          spinner = this.renderer.startThinking();
        }
      }
    } finally {
      spinner?.stop();
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
      case "/clear":
        messages.splice(0, messages.length, { role: "system", content: SYSTEM_PROMPT });
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

function nowIso(): string {
  return new Date().toISOString();
}

export { SUGGESTED_GLM_MODELS };
