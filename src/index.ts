#!/usr/bin/env node
/**
 * RevCode — AI-powered coding agent for the terminal.
 *
 * Entry point. Parses CLI args and starts the agent loop.
 */

import { parseArgs } from "./cli.js";
import { Agent } from "./agent/agent.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const agent = new Agent(args);
  await agent.start();
}

main().catch((err) => {
  console.error("RevCode failed:", err);
  process.exit(1);
});
