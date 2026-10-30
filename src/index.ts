#!/usr/bin/env node
/**
 * RevCode — AI-powered coding agent for the terminal.
 *
 * Entry point: parses the command line, layers config files beneath it, and
 * dispatches to the interactive/headless agent or a subcommand.
 */

import { Agent } from "./agent/agent.js";
import { workingDirectoryProblem } from "./agent/cwd.js";
import { HELP_TEXT, parseCommandLine, resolveArgs, type CliArgs } from "./cli.js";
import { runUniversesCommand } from "./commands/universes.js";
import { runProfileCommand, runSessionsCommand } from "./commands/misc.js";
import { completionScript } from "./commands/completion.js";
import { missingCredentials, runSetup, runSetupCommand } from "./commands/setup.js";
import { loadEnvFiles } from "./config/env.js";
import { loadConfig } from "./config/config.js";
import { reexecWithEnvProxy } from "./net/env-proxy.js";
import { VERSION } from "./version.js";

function withConfig(args: CliArgs): CliArgs {
  const loaded = loadConfig(args.cwd);
  for (const warning of loaded.warnings) {
    process.stderr.write(`[revcode] config: ${warning}\n`);
  }
  return resolveArgs(args, loaded);
}

async function main(): Promise<void> {
  loadEnvFiles();
  const command = parseCommandLine(process.argv.slice(2));

  switch (command.kind) {
    case "help":
      console.log(HELP_TEXT);
      return;
    case "version":
      console.log(`revcode ${VERSION}`);
      return;
    case "sessions":
      process.exitCode = runSessionsCommand(withConfig(command.args));
      return;
    case "profile":
      process.exitCode = runProfileCommand(withConfig(command.args), command.action);
      return;
    case "universes":
      process.exitCode = await runUniversesCommand(withConfig(command.args), command.action, command.rest);
      return;
    case "tune": {
      const { runTuneCommand } = await import("./commands/tune.js");
      process.exitCode = await runTuneCommand(withConfig(command.args), command.options);
      return;
    }
    case "completion": {
      const script = completionScript(command.shell);
      if (!script) {
        console.error("Usage: revcode completion <bash|zsh|fish>");
        process.exitCode = 2;
        return;
      }
      process.stdout.write(script);
      return;
    }
    case "setup":
      process.exitCode = await runSetupCommand(withConfig(command.args));
      return;
    case "race": {
      let args = withConfig(command.args);
      if (process.stdin.isTTY && process.stdout.isTTY && missingCredentials(args) && !(await runSetup({ reason: `${missingCredentials(args)?.message} Let's set one up.` }))) {
        process.exitCode = 1;
        return;
      }
      args = withConfig(command.args);
      const { runRaceCommand } = await import("./commands/race.js");
      process.exitCode = await runRaceCommand(args, command.options);
      return;
    }
    case "run": {
      let args = withConfig(command.args);
      if (!args.headless && process.stdin.isTTY && process.stdout.isTTY) {
        const missing = missingCredentials(args);
        if (missing) {
          if (!(await runSetup({ reason: `${missing.message} Let's set one up.` }))) {
            process.exitCode = 1;
            return;
          }
          args = withConfig(command.args);
        }
      }
      const cwdProblem = workingDirectoryProblem(args.cwd);
      if (cwdProblem) {
        console.error(`[revcode] ${cwdProblem}`);
        process.exitCode = 2;
        return;
      }
      const agent = new Agent(args);
      await agent.start();
      return;
    }
  }
}

reexecWithEnvProxy()
  .then((exitCode) => {
    if (exitCode !== undefined) {
      process.exit(exitCode);
    }
    return main();
  })
  .catch((err) => {
    console.error("RevCode failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
