/**
 * Core agent loop.
 *
 * Owns the conversation with the LLM, dispatches tool calls, and
 * renders output to the terminal.
 */

import type { CliArgs } from "../cli.js";
import { createLlmClient, type LlmClient } from "../llm/client.js";
import { ToolRegistry } from "../tools/index.js";
import { TerminalRenderer } from "../tui/render.js";

export class Agent {
  private readonly args: CliArgs;
  private readonly llm: LlmClient;
  private readonly tools: ToolRegistry;
  private readonly renderer: TerminalRenderer;

  constructor(args: CliArgs) {
    this.args = args;
    this.llm = createLlmClient(args.model);
    this.tools = new ToolRegistry();
    this.renderer = new TerminalRenderer();
  }

  async start(): Promise<void> {
    this.renderer.welcome();

    // TODO: implement the main agent loop
    //   1. Read user input
    //   2. Send to LLM with conversation history + system prompt
    //   3. If response contains tool_use, execute tools and append results
    //   4. Render assistant output
    //   5. Repeat until user exits

    this.renderer.goodbye();
  }
}
