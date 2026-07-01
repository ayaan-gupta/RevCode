/**
 * Tool registry — maps tool names to their implementations.
 */

import { deleteFile, type DeleteToolInput } from "./delete.js";
import { editFile, type EditToolInput } from "./edit.js";
import { globFiles, type GlobToolInput } from "./glob.js";
import { grepFiles, type GrepToolInput } from "./grep.js";
import { listDirectory, type ListToolInput } from "./list.js";
import { execShell, type ShellToolInput } from "./shell.js";
import { ShellSession } from "./shell-session.js";
import { PlanStore, updatePlan, type PlanStep, type UpdatePlanInput } from "./plan.js";
import { readFile, type ReadToolInput } from "./read.js";
import { writeFile, type WriteToolInput } from "./write.js";

/** Tools that only read state and may run concurrently within a turn. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_directory",
  "grep",
  "glob",
]);

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly shellSession: ShellSession;
  private readonly planStore = new PlanStore();

  constructor(options: ToolRegistryOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    this.shellSession = new ShellSession({ cwd });
    this.register({
      definition: readToolDefinition,
      handler: (input) => readFile(input as ReadToolInput, { cwd: options.cwd }),
    });
    this.register({
      definition: writeToolDefinition,
      handler: (input) => writeFile(input as WriteToolInput, { cwd: options.cwd }),
    });
    this.register({
      definition: editToolDefinition,
      handler: (input) => editFile(input as EditToolInput, { cwd: options.cwd }),
    });
    this.register({
      definition: shellToolDefinition,
      handler: (input) => execShell(input as ShellToolInput, { session: this.shellSession }),
    });
    this.register({
      definition: listDirectoryToolDefinition,
      handler: (input) => listDirectory(input as ListToolInput, { cwd: options.cwd }),
    });
    this.register({
      definition: grepToolDefinition,
      handler: (input) => grepFiles(input as GrepToolInput, { cwd: options.cwd }),
    });
    this.register({
      definition: globToolDefinition,
      handler: (input) => globFiles(input as GlobToolInput, { cwd: options.cwd }),
    });
    this.register({
      definition: deleteFileToolDefinition,
      handler: (input) => deleteFile(input as DeleteToolInput, { cwd: options.cwd }),
    });
    this.register({
      definition: updatePlanToolDefinition,
      handler: async (input) => updatePlan(input as UpdatePlanInput, this.planStore),
    });
  }

  /** Current plan steps (for rendering). */
  getPlan(): PlanStep[] {
    return this.planStore.get();
  }

  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(input);
  }

  /** Return tool definitions for the LLM's function-calling interface. */
  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values(), (tool) => tool.definition);
  }

  /** True for tools that only read state and may run concurrently. */
  isReadOnly(name: string): boolean {
    return READ_ONLY_TOOLS.has(name);
  }

  /** Tear down the persistent shell session and its process group. */
  dispose(): void {
    this.shellSession.dispose();
  }
}

export interface ToolRegistryOptions {
  cwd?: string;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export interface ToolHandler {
  (input: unknown): Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const readToolDefinition: ToolDefinition = {
  name: "read_file",
  description:
    "Read a text file from the working directory. Returns content with 1-based line numbers, refuses ignored files, and omits binary content. Do not use for discovery — use list_directory or glob instead.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to read, relative to the agent working directory.",
      },
      offset: {
        type: "integer",
        description:
          "Optional 1-based line number to start reading from. Negative values count back from the end of the file.",
      },
      limit: {
        type: "integer",
        minimum: 0,
        description: "Optional maximum number of lines to return.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const writeToolDefinition: ToolDefinition = {
  name: "write_file",
  description:
    "Write UTF-8 text content to a file inside the working directory, creating parent directories as needed. Returns metadata and a unified diff. Write the complete file content in one call.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to write, relative to the agent working directory.",
      },
      content: {
        type: "string",
        description: "Complete UTF-8 text content to write to the file.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

const editToolDefinition: ToolDefinition = {
  name: "edit_file",
  description:
    "Apply one or more exact text replacements to an existing UTF-8 file inside the working directory. Each oldText must match exactly once. Returns a unified diff.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to edit, relative to the agent working directory.",
      },
      edits: {
        type: "array",
        minItems: 1,
        description: "Ordered exact text replacements to apply.",
        items: {
          type: "object",
          properties: {
            oldText: {
              type: "string",
              description: "Existing text to replace. Must occur exactly once at edit time.",
            },
            newText: {
              type: "string",
              description: "Replacement text.",
            },
          },
          required: ["oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  },
};

const shellToolDefinition: ToolDefinition = {
  name: "shell",
  description:
    "Execute a command in a PERSISTENT bash session: working directory (cd), exported environment, activated virtualenvs, and background jobs all persist across calls. stdout and stderr are merged into one stream; large output is truncated keeping the head and tail. To start a long-running process (e.g. a server) set background:true so it keeps running and the call returns immediately — do NOT run a server in the foreground or the call will block until it times out. Do not use ls/find for directory listing (use list_directory); for content search prefer grep; for file discovery prefer glob.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute in the persistent session.",
      },
      timeout: {
        type: "integer",
        minimum: 1,
        maximum: 600000,
        description: "Optional timeout in milliseconds. Defaults to 120000 and caps at 600000.",
      },
      background: {
        type: "boolean",
        description:
          "Run the command detached (redirected to a log file) and return immediately. Use for servers, watchers, and other long-running processes. Read its output later with shell(\"cat <logFile>\").",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

const listDirectoryToolDefinition: ToolDefinition = {
  name: "list_directory",
  description:
    "List files and subdirectories in a directory inside the working directory. Directories are marked with a trailing slash. Use before read_file when paths are unknown or when locating files by name.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list, relative to the agent working directory.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const grepToolDefinition: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with ripgrep inside the working directory. Prefer this over reading many files or using shell grep/rg for simple searches.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression or literal pattern to search for.",
      },
      path: {
        type: "string",
        description: "Optional file or directory path to search, relative to the working directory.",
      },
      glob: {
        type: "string",
        description: "Optional glob filter, e.g. '*.ts'.",
      },
      context: {
        type: "integer",
        minimum: 0,
        description: "Optional number of context lines before and after each match.",
      },
      head_limit: {
        type: "integer",
        minimum: 1,
        description: "Optional maximum number of matches per file.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

const globToolDefinition: ToolDefinition = {
  name: "glob",
  description:
    "Find files by glob pattern within the working directory. Prefer this over shell find when discovering files by name.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern, e.g. '**/*.ts' or 'src/**/*.py'.",
      },
      path: {
        type: "string",
        description: "Optional directory to search from, relative to the working directory.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

const deleteFileToolDefinition: ToolDefinition = {
  name: "delete_file",
  description:
    "Delete a single file inside the working directory. Refuses directories and git-ignored files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to delete, relative to the agent working directory.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const updatePlanToolDefinition: ToolDefinition = {
  name: "update_plan",
  description:
    "Record or update an ordered checklist for a multi-step task. Call this at the start of non-trivial work and whenever a step's status changes. Keep exactly one step 'in_progress'. Pass the full list each time (it replaces the previous plan). Skip for trivial single-step tasks.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        description: "The complete ordered list of steps with their current status.",
        items: {
          type: "object",
          properties: {
            step: { type: "string", description: "Short description of the step." },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Current status of the step.",
            },
          },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
};
