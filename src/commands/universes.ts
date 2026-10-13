/**
 * `revcode universes <action>` — manage Parallel Universes from the shell.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import type { CliArgs } from "../cli.js";
import { compareUniverses, formatComparison } from "../universe/compare.js";
import { renderUniverseHtml } from "../universe/export-html.js";
import { replayUniverse } from "../universe/replay.js";
import { describeUniverse, formatChangeSummary, formatCheckpoints, formatUniverseList, landFlow } from "../universe/ui.js";
import { Universe, type UniverseMeta } from "../universe/universe.js";

export async function runUniversesCommand(args: CliArgs, action: string, rest: string[]): Promise<number> {
  const flags = new Flags(rest);
  try {
    switch (action) {
      case "list":
      case "ls": {
        const metas = Universe.list({ projectRoot: flags.has("--all") ? undefined : args.cwd, includeDiscarded: flags.has("--all") });
        console.log(formatUniverseList(metas).join("\n"));
        if (!flags.has("--all") && metas.length === 0) console.log("(showing this project only; use --all for every project)");
        return 0;
      }
      case "show": {
        const u = pick(flags, args.cwd);
        console.log(describeUniverse(u.meta).join("\n"));
        if (u.meta.status !== "discarded") {
          console.log("");
          console.log(formatChangeSummary(await u.changesBetween(u.meta.baseSha, await u.snapshotHead("show"))).join("\n"));
        }
        console.log("");
        console.log(formatCheckpoints(u.checkpoints(), 20).join("\n"));
        return 0;
      }
      case "diff": {
        const u = pick(flags, args.cwd);
        console.log(formatChangeSummary(await u.changesBetween(u.meta.baseSha, await u.snapshotHead("diff"))).join("\n"));
        if (flags.has("--full")) console.log(`\n${await u.diff()}`);
        return 0;
      }
      case "land": {
        const u = pick(flags, args.cwd);
        const onConflict = flags.has("--theirs") ? "theirs" : flags.has("--markers") ? "markers" : "skip";
        const result = await landFlow(u, {
          paths: flags.positionals().slice(1),
          onConflict,
          confirm: async (_plan, lines) => {
            console.log(lines.join("\n"));
            return flags.has("--yes") || flags.has("-y") || (await askYesNo(`Apply these changes to ${u.meta.projectRoot}?`));
          },
        });
        const printed = result.landed ? result.lines.slice(result.lines.findIndex((l) => l.startsWith("Landed"))) : result.lines.filter((l) => !l.startsWith("  ") && !l.startsWith("Landing"));
        console.log(printed.join("\n"));
        return 0;
      }
      case "discard": {
        const u = pick(flags, args.cwd);
        if (!(flags.has("--yes") || flags.has("-y") || (await askYesNo(`Throw away universe ${u.id} and its changes?`)))) {
          console.log("Kept.");
          return 0;
        }
        u.discard();
        console.log(`Discarded ${u.id}.`);
        return 0;
      }
      case "purge": {
        if (flags.has("--discarded")) {
          const gone = Universe.list({ includeDiscarded: true }).filter((m) => m.status === "discarded");
          for (const meta of gone) Universe.open(meta.id).purge();
          console.log(`Purged ${gone.length} discarded universe record(s).`);
          return 0;
        }
        const u = pick(flags, args.cwd);
        u.purge();
        console.log(`Purged ${u.id}.`);
        return 0;
      }
      case "fork": {
        const u = pick(flags, args.cwd);
        const n = flags.positionals()[1] ? Number.parseInt(flags.positionals()[1], 10) : undefined;
        const child = await u.fork(n);
        console.log(`Forked ${u.id} → ${child.id}`);
        return 0;
      }
      case "share": {
        const u = pick(flags, args.cwd);
        const out = path.resolve(flags.value("--out") ?? `revcode-${u.id}.html`);
        writeFileSync(out, await renderUniverseHtml(u), "utf8");
        console.log(`Wrote ${out}`);
        return 0;
      }
      case "replay": {
        const u = pick(flags, args.cwd);
        const model = flags.value("--model") ?? args.model;
        const provider = flags.value("--provider") as CliArgs["provider"] | undefined;
        console.log(`Replaying ${u.id} (${u.prompts().length} prompt(s)) on ${model}…`);
        const result = await replayUniverse(u, {
          args,
          model,
          provider,
          name: flags.value("--name"),
          onProgress: (message) => console.log(`  ${message}`),
        });
        const last = result.turns.at(-1);
        console.log(`Created ${result.universe.id}. Compare with: revcode universes compare ${u.id} ${result.universe.id} --verify "<your test command>"`);
        if (last?.result.stopReason === "error") return 1;
        return 0;
      }
      case "compare": {
        const [aId, bId] = flags.positionals();
        if (!aId || !bId) throw new Error("Usage: revcode universes compare <a> <b> [--verify \"command\"]");
        const comparison = await compareUniverses(find(aId, args.cwd), find(bId, args.cwd), { verify: flags.value("--verify") });
        console.log(formatComparison(comparison).join("\n"));
        return 0;
      }
      default:
        console.error(`Unknown universes action: ${action}\nActions: list, show, diff, land, discard, purge, fork, share, replay, compare`);
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Resolve an id (or unique prefix, or "latest"/nothing for the newest in this project). */
export function find(idOrPrefix: string | undefined, cwd: string): Universe {
  const all = Universe.list({ includeDiscarded: true });
  if (!idOrPrefix || idOrPrefix === "latest") {
    const mine = all.filter((m) => m.projectRoot === path.resolve(cwd) && m.status !== "discarded");
    if (mine.length === 0) throw new Error("No universes for this project. Start one with: revcode --universe");
    return Universe.open(mine[0].id);
  }
  const matches: UniverseMeta[] = all.filter((m) => m.id === idOrPrefix || m.id.startsWith(idOrPrefix));
  if (matches.length === 0) throw new Error(`No such universe: ${idOrPrefix}`);
  const exact = matches.find((m) => m.id === idOrPrefix);
  if (!exact && matches.length > 1) throw new Error(`Ambiguous universe id "${idOrPrefix}": ${matches.map((m) => m.id).join(", ")}`);
  return Universe.open((exact ?? matches[0]).id);
}

function pick(flags: Flags, cwd: string): Universe {
  return find(flags.positionals()[0], cwd);
}

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("Not a terminal; pass --yes to confirm non-interactively.");
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Tiny argv helper for subcommand-specific flags. */
export class Flags {
  constructor(private readonly tokens: string[]) {}

  has(flag: string): boolean {
    return this.tokens.includes(flag);
  }

  value(flag: string): string | undefined {
    const index = this.tokens.indexOf(flag);
    if (index !== -1) return this.tokens[index + 1];
    const inline = this.tokens.find((t) => t.startsWith(`${flag}=`));
    return inline?.slice(flag.length + 1);
  }

  positionals(): string[] {
    const valueFlags = new Set(["--model", "--provider", "--verify", "--out", "--name"]);
    const out: string[] = [];
    for (let i = 0; i < this.tokens.length; i += 1) {
      const token = this.tokens[i];
      if (token.startsWith("--") || token === "-y") {
        if (valueFlags.has(token)) i += 1;
        continue;
      }
      out.push(token);
    }
    return out;
  }
}
