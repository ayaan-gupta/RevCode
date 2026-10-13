/**
 * `revcode tune` — Dyno. Benchmarks harness settings against a model on the
 * built-in suite and saves the best profile for it.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import { resolveProvider, createLlmClient } from "../llm/client.js";
import type { CliArgs, TuneOptions } from "../cli.js";
import { saveStoredProfile } from "../harness/profile.js";
import { AVAILABLE_EDIT_MODES } from "../tools/edit-modes.js";
import { formatDryRun, formatTuneProgress, renderLiftCard } from "../dyno/report.js";
import { runDynoTask } from "../dyno/runner.js";
import { selectTasks } from "../dyno/suite/index.js";
import { tuneProfile } from "../dyno/tuner.js";
import type { EditMode } from "../harness/profile.js";

export async function runTuneCommand(args: CliArgs, options: TuneOptions): Promise<number> {
  const provider = resolveProvider(args.provider, args.model);
  const tasks = selectTasks(options.tasks, options.categories as never);
  if (tasks.length === 0) {
    console.error("No tasks selected. Check --tasks / --categories.");
    return 2;
  }

  const editModes = (options.editModes?.length ? options.editModes : AVAILABLE_EDIT_MODES).filter((mode): mode is EditMode =>
    (AVAILABLE_EDIT_MODES as readonly string[]).includes(mode),
  );
  if (editModes.length === 0) {
    console.error(`None of the requested edit modes are available. Available: ${AVAILABLE_EDIT_MODES.join(", ")}`);
    return 2;
  }

  console.log(`Dyno — tuning the harness for ${provider}/${args.model}\n`);
  if (options.dryRun) {
    console.log(formatDryRun(tasks, options.trials, options.budget, editModes).join("\n"));
    return 0;
  }

  if (!options.yes && !(await confirmUnrestricted(args.model))) {
    console.log("Cancelled. (Pass --yes to skip this question.)");
    return 1;
  }

  const llm = createLlmClient({ model: args.model, provider: args.provider, baseUrl: args.baseUrl });
  const started = Date.now();

  const result = await tuneProfile({
    tasks,
    trials: options.trials,
    budget: options.budget,
    concurrency: Number(process.env.REVCODE_TUNE_CONCURRENCY) || 2,
    editModes,
    runTask: (task, profile) => runDynoTask({ task, profile, llm, model: args.model, provider: args.provider }),
    onProgress: (event) => {
      const line = formatTuneProgress(event);
      if (line) console.log(line);
    },
  });

  const card = renderLiftCard(result, { provider, model: args.model, suite: "builtin", tasks, trials: options.trials });
  console.log(`\n${card}\n`);

  if (options.cardOut) {
    const out = path.resolve(options.cardOut);
    writeFileSync(out, `${card}\n`, "utf8");
    console.log(`Wrote lift card to ${out}`);
  }

  if (result.improved && !options.noSave) {
    const file = saveStoredProfile({
      profile: result.finalProfile,
      provider,
      model: args.model,
      tunedAt: new Date().toISOString(),
      evidence: {
        suite: "builtin",
        baselineScore: result.baseline.score,
        tunedScore: result.final.score,
        tasks: tasks.length,
        trials: options.trials,
      },
    });
    console.log(`Saved tuned profile → ${file}\nRevCode will use it automatically for ${args.model} (override with --profile default).`);
  } else if (!result.improved) {
    console.log("No profile saved — the defaults are the best known settings for this model.");
  }
  console.log(`(${Math.round((Date.now() - started) / 1000)}s total)`);
  return 0;
}

/**
 * Benchmarking an agent means letting a model run shell commands unattended.
 * The tasks run in throwaway temp directories, but the commands themselves are not
 * sandboxed, so make the user say yes (or pass --yes, e.g. inside a container).
 */
async function confirmUnrestricted(model: string): Promise<boolean> {
  console.log(
    `⚠ Dyno will run ${model} autonomously: it executes shell commands and edits files with NO approval prompts,\n` +
      "  inside temporary task directories. The directories are disposable, but the commands are not sandboxed.\n" +
      "  Run this in a container or VM if you do not fully trust the model.\n",
  );
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
