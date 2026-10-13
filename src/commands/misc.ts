/**
 * Small subcommands: `revcode sessions`, `revcode profile <show|reset>`.
 */

import { existsSync, rmSync } from "node:fs";
import type { CliArgs } from "../cli.js";
import { listSessions } from "../agent/session.js";
import { resolveProfile } from "../agent/setup.js";
import { loadStoredProfile, profilePath } from "../harness/profile.js";
import { resolveProvider } from "../llm/client.js";

export function runSessionsCommand(args: CliArgs): number {
  const sessions = listSessions({ cwd: args.cwd }).slice(0, 30);
  if (sessions.length === 0) {
    console.log("No saved sessions for this directory.");
    return 0;
  }
  for (const s of sessions) {
    console.log(`${s.id}  ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${s.model.padEnd(18)} ${s.turns} turn(s)  ${s.title}${s.universeId ? `  [${s.universeId}]` : ""}`);
  }
  console.log("\nResume with: revcode -r <id>   (or revcode -c for the latest)");
  return 0;
}

export function runProfileCommand(args: CliArgs, action: string): number {
  const provider = resolveProvider(args.provider, args.model);
  if (action === "reset") {
    const file = profilePath(provider, args.model);
    if (existsSync(file)) {
      rmSync(file);
      console.log(`Removed tuned profile for ${provider}/${args.model}.`);
    } else {
      console.log(`No tuned profile for ${provider}/${args.model}.`);
    }
    return 0;
  }
  if (action !== "show") {
    console.error(`Unknown profile action: ${action}. Use show or reset.`);
    return 2;
  }
  const { profile, source } = resolveProfile(args.profile, provider, args.model);
  const stored = loadStoredProfile(provider, args.model);
  console.log(`Model: ${provider}/${args.model}\nProfile source: ${source}`);
  console.log(JSON.stringify(profile, null, 2));
  if (stored?.evidence) {
    const e = stored.evidence;
    console.log(`\nTuned ${stored.tunedAt}: ${(e.baselineScore * 100).toFixed(0)}% → ${(e.tunedScore * 100).toFixed(0)}% on ${e.tasks} task(s) × ${e.trials} trial(s) (suite: ${e.suite})`);
  } else if (source !== "tuned") {
    console.log(`\nNo tuned profile yet. Run: revcode tune --model ${args.model}`);
  }
  return 0;
}
