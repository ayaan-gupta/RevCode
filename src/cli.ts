/**
 * CLI argument parsing.
 */

import type { LlmProvider } from "./llm/client.js";

export interface CliArgs {
  /** Working directory for the agent. Defaults to cwd. */
  cwd: string;
  /** Model identifier (e.g. "glm-4.6", "claude-sonnet-4-20250514"). */
  model: string;
  /** LLM provider to use. */
  provider?: LlmProvider;
  /** Run in non-interactive / headless mode. */
  headless: boolean;
  /** Task instruction for headless mode. */
  prompt?: string;
  /** Output path for JSONL trajectory logs. */
  trajectoryOut?: string;
  /** Maximum tool loop iterations per user turn. */
  maxIterations: number;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    cwd: process.cwd(),
    model: "glm-4.6",
    headless: false,
    maxIterations: 25,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--headless") {
      args.headless = true;
      continue;
    }

    if (arg === "--cwd") {
      args.cwd = readFlagValue(argv, index, "--cwd");
      index += 1;
      continue;
    }

    if (arg.startsWith("--cwd=")) {
      args.cwd = arg.slice("--cwd=".length);
      continue;
    }

    if (arg === "--model") {
      args.model = readFlagValue(argv, index, "--model");
      index += 1;
      continue;
    }

    if (arg.startsWith("--model=")) {
      args.model = arg.slice("--model=".length);
      continue;
    }

    if (arg === "--provider") {
      args.provider = readProvider(readFlagValue(argv, index, "--provider"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--provider=")) {
      args.provider = readProvider(arg.slice("--provider=".length));
      continue;
    }

    if (arg === "--prompt") {
      args.prompt = readFlagValue(argv, index, "--prompt");
      index += 1;
      continue;
    }

    if (arg.startsWith("--prompt=")) {
      args.prompt = arg.slice("--prompt=".length);
      continue;
    }

    if (arg === "--trajectory-out") {
      args.trajectoryOut = readFlagValue(argv, index, "--trajectory-out");
      index += 1;
      continue;
    }

    if (arg.startsWith("--trajectory-out=")) {
      args.trajectoryOut = arg.slice("--trajectory-out=".length);
      continue;
    }

    if (arg === "--max-iterations") {
      args.maxIterations = readPositiveInteger(readFlagValue(argv, index, "--max-iterations"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--max-iterations=")) {
      args.maxIterations = readPositiveInteger(arg.slice("--max-iterations=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function readProvider(value: string): LlmProvider {
  if (value === "zai" || value === "anthropic" || value === "local-test") {
    return value;
  }

  throw new Error(`Unknown provider: ${value}. Expected zai, anthropic, or local-test.`);
}

function readPositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }

  return parsed;
}
