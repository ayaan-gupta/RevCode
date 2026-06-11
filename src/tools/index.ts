/**
 * Tool registry — maps tool names to their implementations.
 *
 * TODO: register all tools and provide the tool definitions
 *       the LLM client needs for function calling.
 */

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler>();

  constructor() {
    // TODO: register read, write, edit, shell, grep, glob, etc.
  }

  register(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool(input);
  }

  /** Return tool definitions for the LLM's function-calling interface. */
  definitions(): ToolDefinition[] {
    // TODO: build from registered tools
    return [];
  }
}

export interface ToolHandler {
  (input: unknown): Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
