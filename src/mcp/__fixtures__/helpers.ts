/** Shared helpers for the MCP tests (not part of the runtime API). */

import path from "node:path";

import type { McpStdioServerConfig } from "../config.js";

export const MOCK_SERVER_PATH = path.join(__dirname, "mock-server.mjs");
/** Number of tools the mock server lists (spread over several pages). */
export const MOCK_TOOL_COUNT = 14;

/** Config that launches the mock stdio server with extra behaviour switches. */
export function mockStdioConfig(
  name: string,
  env: Record<string, string> = {},
  overrides: Partial<McpStdioServerConfig> = {},
): McpStdioServerConfig {
  return {
    type: "stdio",
    name,
    command: process.execPath,
    args: [MOCK_SERVER_PATH],
    env,
    disabled: false,
    source: "test",
    ...overrides,
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Await a promise that must reject and return the error. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}
