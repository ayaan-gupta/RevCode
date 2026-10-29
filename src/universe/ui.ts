/**
 * Plain-text presentation of universes, shared by the TUI slash commands and the
 * `revcode universes …` subcommands. Functions return lines; callers decide
 * about color and where to print.
 */

import path from "node:path";
import type { ConflictStrategy, LandItem, LandPlan } from "./land.js";
import { applyLand, planLand, summarizePlan } from "./land.js";
import type { Checkpoint, FileChange, Universe, UniverseMeta } from "./universe.js";

export function describeUniverse(meta: UniverseMeta): string[] {
  const lines = [
    `${meta.id}${meta.name ? `  “${meta.name}”` : ""}  [${meta.status}]`,
    `  project   ${meta.projectRoot}`,
    `  created   ${meta.createdAt}${meta.model ? `  ·  ${meta.provider ?? "?"}/${meta.model}` : ""}`,
  ];
  if (meta.parentId) lines.push(`  forked    from ${meta.parentId}`);
  if (meta.linked.length > 0) lines.push(`  shared    ${meta.linked.join(", ")} (symlinked from the project, not isolated)`);
  if (meta.skippedLarge.length > 0) lines.push(`  skipped   ${meta.skippedLarge.length} file(s) over the size limit`);
  if (meta.landedCount > 0) lines.push(`  landed    ${meta.landedCount}× (last ${meta.lastLandedAt})`);
  return lines;
}

export function formatUniverseList(metas: UniverseMeta[]): string[] {
  if (metas.length === 0) {
    return ["No universes. Start one with: revcode --universe"];
  }
  return metas.map((meta) => {
    const when = meta.updatedAt.slice(0, 16).replace("T", " ");
    const name = meta.name ? `  ${meta.name}` : "";
    return `${meta.id}  ${meta.status.padEnd(9)} ${when}  ${shortPath(meta.projectRoot)}${name}`;
  });
}

export function formatCheckpoints(checkpoints: Checkpoint[], limit = 25): string[] {
  const shown = checkpoints.filter((c) => c.kind !== "base" || checkpoints.length <= limit).slice(-limit);
  if (shown.length === 0) return ["No checkpoints yet."];
  return shown.map((c) => {
    const flag = c.changed ? "●" : "○";
    const exit = c.exitCode === undefined || c.exitCode === null ? "" : c.exitCode === 0 ? "" : `  (exit ${c.exitCode})`;
    return `#${String(c.n).padEnd(3)} ${flag} ${c.kind.padEnd(6)} ${c.summary}${exit}`;
  });
}

export function formatChangeSummary(changes: FileChange[]): string[] {
  if (changes.length === 0) return ["No changes."];
  const lines = changes.map((c) => `  ${c.status}  ${c.path}${counts(c)}`);
  const add = changes.reduce((n, c) => n + c.insertions, 0);
  const del = changes.reduce((n, c) => n + c.deletions, 0);
  lines.push(`  ${changes.length} file${changes.length === 1 ? "" : "s"} changed, +${add} −${del}`);
  return lines;
}

function counts(change: FileChange): string {
  if (change.insertions === 0 && change.deletions === 0) return "";
  return `  (${change.insertions ? `+${change.insertions}` : ""}${change.insertions && change.deletions ? " " : ""}${change.deletions ? `−${change.deletions}` : ""})`;
}

const MARKS: Record<LandItem["action"], string> = {
  write: "→",
  delete: "✕",
  identical: "=",
  "already-gone": "=",
  conflict: "!",
};

export function formatLandPlan(plan: LandPlan, changes: FileChange[]): string[] {
  const byPath = new Map(changes.map((c) => [c.path, c]));
  const lines = [`Landing ${plan.universeId} → ${plan.projectRoot}`];
  for (const item of plan.items) {
    const change = byPath.get(item.path);
    const stat = change ? counts(change) : "";
    const note =
      item.action === "conflict"
        ? `  CONFLICT: ${item.detail ?? "changed on both sides"}`
        : item.merged
          ? "  auto-merged with your changes"
          : item.action === "identical" || item.action === "already-gone"
            ? "  already in place"
            : "";
    lines.push(`  ${MARKS[item.action]} ${item.status}  ${item.path}${stat}${note}`);
  }
  lines.push(`  ${summarizePlan(plan)}`);
  return lines;
}

export interface LandFlowOptions {
  paths?: string[];
  onConflict?: ConflictStrategy;
  /** Return false to cancel after the plan is shown. */
  confirm: (plan: LandPlan, lines: string[]) => Promise<boolean>;
}

export interface LandFlowResult {
  lines: string[];
  landed: boolean;
}

/** What to print once `confirm` has already shown the plan, so the plan isn't printed twice. */
export function landOutcome(result: LandFlowResult): string[] {
  if (result.landed) return result.lines.slice(Math.max(0, result.lines.findIndex((l) => l.startsWith("Landed"))));
  return result.lines.filter((l) => !l.startsWith("  ") && !l.startsWith("Landing"));
}

/** Plan → show → confirm → apply. Shared by `/land` and `revcode universes land`. */
export async function landFlow(universe: Universe, options: LandFlowOptions): Promise<LandFlowResult> {
  const plan = await planLand(universe, { paths: options.paths });
  const actionable = plan.items.filter((i) => i.action !== "identical" && i.action !== "already-gone");
  if (actionable.length === 0) {
    return { lines: ["Nothing to land — your project already has everything in this universe."], landed: false };
  }
  const changes = await universe.changesBetween(plan.baseSha, plan.headSha);
  const lines = formatLandPlan(plan, changes);
  if (!(await options.confirm(plan, lines))) {
    return { lines: [...lines, "Cancelled."], landed: false };
  }
  const result = await applyLand(universe, plan, { onConflict: options.onConflict });
  const out = [
    ...lines,
    `Landed: ${result.written.length} written, ${result.deleted.length} deleted${result.merged.length ? `, ${result.merged.length} auto-merged` : ""}.`,
  ];
  if (result.conflicts.length > 0) {
    out.push(
      `${result.conflicts.length} conflict${result.conflicts.length === 1 ? "" : "s"} left untouched: ${result.conflicts.join(", ")}`,
      "Resolve by editing your project, or re-run with --markers (write conflict markers) or --theirs (take the universe version).",
    );
  }
  return { lines: out, landed: true };
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  const display = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  return display.length > 48 ? `…${display.slice(-47)}` : path.normalize(display);
}
