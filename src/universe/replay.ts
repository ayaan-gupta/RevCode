/**
 * Replay: re-run a universe's recorded prompts, from the same starting point, on
 * a different model (or the same one, or a new harness profile).
 *
 * The replay starts from the source's BASE checkpoint — the project exactly as it
 * was — so two universes are a fair head-to-head: same task, same files, same
 * prompts, different brain. Compare them with `compareUniverses`.
 */

import type { CliArgs } from "../cli.js";
import { createRuntime } from "../agent/setup.js";
import { runTrackedTurn } from "../agent/turn.js";
import type { TurnResult } from "../agent/engine.js";
import type { LlmClient } from "../llm/client.js";
import type { HarnessProfile } from "../harness/profile.js";
import type { Receipt } from "./receipts.js";
import type { Universe } from "./universe.js";

export interface ReplayOptions {
  args: CliArgs;
  model: string;
  provider?: CliArgs["provider"];
  name?: string;
  /** Inject a client (tests). */
  llm?: LlmClient;
  profile?: HarnessProfile;
  onProgress?: (message: string) => void;
}

export interface ReplayResult {
  universe: Universe;
  turns: Array<{ prompt: string; result: TurnResult; receipt: Receipt }>;
}

export async function replayUniverse(source: Universe, options: ReplayOptions): Promise<ReplayResult> {
  const prompts = source.prompts();
  if (prompts.length === 0) {
    throw new Error(`Universe ${source.id} has no recorded prompts to replay.`);
  }
  const base = source.checkpoints().find((c) => c.kind === "base");
  const child = await source.fork(base?.n ?? 1, { name: options.name ?? `replay of ${source.id} on ${options.model}` });
  child.setModel(options.provider ?? source.meta.provider, options.model);

  const args: CliArgs = {
    ...options.args,
    cwd: source.meta.projectRoot,
    model: options.model,
    provider: options.provider ?? options.args.provider,
    headless: true,
    universe: true,
    snapshot: options.args.snapshot ?? true,
  };

  const runtime = await createRuntime({
    args,
    interactive: false,
    universe: child,
    llm: options.llm,
    profile: options.profile,
    warn: (message) => options.onProgress?.(`! ${message}`),
    task: prompts[0].text,
  });

  const turns: ReplayResult["turns"] = [];
  try {
    for (const [index, prompt] of prompts.entries()) {
      options.onProgress?.(`turn ${index + 1}/${prompts.length}: ${prompt.text.slice(0, 70).replace(/\s+/g, " ")}`);
      runtime.completion?.setTask(prompt.text);
      const { result, receipt } = await runTrackedTurn(runtime, prompt.text);
      turns.push({ prompt: prompt.text, result, receipt });
      if (result.stopReason === "error") {
        options.onProgress?.(`! model error: ${result.error ?? "unknown"}`);
        break;
      }
    }
  } finally {
    await runtime.dispose();
  }
  return { universe: child, turns };
}
