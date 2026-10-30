/**
 * Compare two universes (typically the same task run by two models, via replay).
 *
 * Reports cost/effort from the recorded receipts, how the resulting file trees
 * differ, and — when given a verification command — whether each result actually
 * passes it. The verification run is the honest A/B signal; the rest is context.
 */

import { existsSync } from "node:fs";
import { runCheck } from "./check.js";
import { runShadowGit } from "./git.js";
import type { Receipt } from "./receipts.js";
import type { Universe } from "./universe.js";

export interface UniverseSummary {
  id: string;
  model?: string;
  files: number;
  insertions: number;
  deletions: number;
  turns: number;
  toolCalls: number;
  commands: number;
  durationMs: number;
  tokens: number;
  testsModified: string[];
  verify?: { exitCode: number | null; passed: boolean; tail: string };
}

export interface Comparison {
  a: UniverseSummary;
  b: UniverseSummary;
  /** Paths whose final content differs between the two universes. */
  differing: Array<{ path: string; status: "only-a" | "only-b" | "different" }>;
}

export async function compareUniverses(a: Universe, b: Universe, options: { verify?: string; verifyTimeoutSec?: number } = {}): Promise<Comparison> {
  const [sa, sb] = await Promise.all([summarize(a, options), summarize(b, options)]);
  const differing = await treeDifferences(a, b);
  return { a: sa, b: sb, differing };
}

async function summarize(universe: Universe, options: { verify?: string; verifyTimeoutSec?: number }): Promise<UniverseSummary> {
  const receipts = universe.timeline().filter((e) => e.type === "receipt") as unknown as Receipt[];
  const stat = existsSync(universe.workDir) ? await universe.diffStat() : { files: 0, insertions: 0, deletions: 0 };
  const summary: UniverseSummary = {
    id: universe.id,
    model: universe.meta.model,
    ...stat,
    turns: receipts.length,
    toolCalls: receipts.reduce((n, r) => n + r.toolCalls, 0),
    commands: receipts.reduce((n, r) => n + r.commands.length, 0),
    durationMs: receipts.reduce((n, r) => n + r.durationMs, 0),
    tokens: receipts.reduce((n, r) => n + (r.tokens?.input ?? 0) + (r.tokens?.output ?? 0), 0),
    testsModified: [...new Set(receipts.flatMap((r) => r.testsModified))],
  };
  if (options.verify && existsSync(universe.workDir)) {
    const check = await runCheck(universe.workDir, options.verify, { timeoutMs: (options.verifyTimeoutSec ?? 600) * 1000 });
    summary.verify = { exitCode: check.exitCode, passed: check.passed, tail: check.tail };
  }
  return summary;
}

async function treeDifferences(a: Universe, b: Universe): Promise<Comparison["differing"]> {
  if (!existsSync(a.shadow().gitDir) || !existsSync(b.shadow().gitDir)) {
    return [];
  }
  const headA = await a.snapshotHead("compare");
  await b.snapshotHead("compare");
  // Bring B's history into A's object store, then diff the two trees in one repo.
  await runShadowGit(a.shadow(), ["fetch", "-q", "--no-tags", b.shadow().gitDir, `+main:refs/compare/${b.id}`]);
  const out = (await runShadowGit(a.shadow(), ["diff", "--name-status", "-z", "--no-renames", headA, `refs/compare/${b.id}`])).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const result: Comparison["differing"] = [];
  for (let i = 0; i + 1 < out.length; i += 2) {
    // diff A→B: "A" = only in B, "D" = only in A.
    const status = out[i][0] === "A" ? "only-b" : out[i][0] === "D" ? "only-a" : "different";
    result.push({ path: out[i + 1], status });
  }
  return result;
}

export function formatComparison(c: Comparison): string[] {
  const row = (label: string, x: string | number, y: string | number): string =>
    `  ${label.padEnd(22)} ${String(x).padEnd(18)} ${String(y)}`;
  const secs = (ms: number): string => `${(ms / 1000).toFixed(0)}s`;
  const lines = [
    `  ${"".padEnd(22)} ${c.a.id.padEnd(18)} ${c.b.id}`,
    row("model", c.a.model ?? "?", c.b.model ?? "?"),
    row("files changed", c.a.files, c.b.files),
    row("lines +/−", `+${c.a.insertions} −${c.a.deletions}`, `+${c.b.insertions} −${c.b.deletions}`),
    row("tool calls", c.a.toolCalls, c.b.toolCalls),
    row("commands run", c.a.commands, c.b.commands),
    row("agent time", secs(c.a.durationMs), secs(c.b.durationMs)),
    row("tokens", c.a.tokens || "n/a", c.b.tokens || "n/a"),
  ];
  if (c.a.verify || c.b.verify) {
    const v = (s: UniverseSummary): string => (s.verify ? (s.verify.passed ? "PASS" : `FAIL (exit ${s.verify.exitCode ?? "?"})`) : "n/a");
    lines.push(row("verification", v(c.a), v(c.b)));
  }
  for (const [label, s] of [["A", c.a], ["B", c.b]] as const) {
    if (s.testsModified.length > 0) lines.push(`  ⚠ ${label} modified existing tests: ${s.testsModified.join(", ")}`);
  }
  lines.push("", c.differing.length === 0 ? "  The two results are identical." : `  ${c.differing.length} file(s) differ:`);
  for (const d of c.differing.slice(0, 30)) {
    lines.push(`    ${d.status === "only-a" ? "A only" : d.status === "only-b" ? "B only" : "differs"}  ${d.path}`);
  }
  return lines;
}
