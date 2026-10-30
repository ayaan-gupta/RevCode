/**
 * The race scoreboard: a live view while attempts run, and the final ranking.
 */

import { formatUsd } from "../llm/pricing.js";
import { describeStop } from "../universe/receipts.js";
import type { Style } from "../tui/style.js";
import { padEnd, padStart, truncate } from "../tui/width.js";
import { duplicates, qualifies, type Attempt, type RaceResult } from "./race.js";

export interface BoardContext {
  style: Style;
  width: number;
  check?: string;
  capUsd?: number;
  spentUsd: number;
  /** Show dollar amounts (a price is known for at least one model). */
  priced: boolean;
  now?: number;
  frame?: number;
}

const MODEL_WIDTH = 20;
const STATUS_WIDTH = 15;

export function boardHeader(task: string, attempts: number, ctx: BoardContext): string[] {
  const { style } = ctx;
  const parts = [`${attempts} attempts`, ctx.check ? `check: ${ctx.check}` : "no check command", ...(ctx.capUsd !== undefined ? [`cap ${formatUsd(ctx.capUsd)}`] : [])];
  return [
    `${style.paint("accent", style.unicode ? "⌬" : "#")} ${style.bold("Race")} ${style.dim(parts.join(` ${style.glyphs.dot} `))}`,
    style.dim(`  ${truncate(task.replace(/\s+/g, " "), Math.max(10, ctx.width - 4))}`),
  ];
}

/** One row per attempt while the race runs. */
export function liveRows(attempts: readonly Attempt[], ctx: BoardContext): string[] {
  const { style } = ctx;
  const now = ctx.now ?? Date.now();
  const spinner = style.glyphs.spinner[(ctx.frame ?? 0) % style.glyphs.spinner.length];
  const rows = attempts.map((a) => {
    let status: string;
    let detail = "";
    switch (a.status) {
      case "waiting":
        status = style.dim("waiting");
        break;
      case "working":
        status = style.paint("accent", `${spinner} working`);
        detail = a.activity ?? "";
        break;
      case "checking":
        status = style.paint("heading", `${spinner} checking`);
        detail = a.activity ?? "";
        break;
      case "done":
        status = outcomeLabel(a, ctx);
        detail = changeSummary(a, style);
        break;
    }
    return row(a, status, detail, now, ctx);
  });
  const footer = ctx.priced ? [style.dim(`  spent ${formatUsd(ctx.spentUsd)}${ctx.capUsd !== undefined ? ` of ${formatUsd(ctx.capUsd)}` : ""}${style.unicode ? "  ·  ctrl+c stops every attempt" : "  -  ctrl+c stops every attempt"}`)] : [style.dim("  ctrl+c stops every attempt")];
  return [...rows, ...footer];
}

/** The final ranking, best first, with the winner marked. */
export function finalRows(result: RaceResult, ctx: BoardContext): string[] {
  const { style } = ctx;
  const same = duplicates(result.ranked);
  const rows = result.ranked.map((a) => {
    const notes: string[] = [];
    const match = same.get(a.spec.n);
    if (match !== undefined) notes.push(`same code as #${match}`);
    if ((a.receipt?.testsModified.length ?? 0) > 0) notes.push(style.paint("warn", `${style.glyphs.warn} edited a test`));
    const detail = [changeSummary(a, style), ...notes].filter(Boolean).join(` ${style.glyphs.dot} `);
    const line = row(a, outcomeLabel(a, ctx), detail, a.endedAt ?? Date.now(), ctx);
    return a === result.winner ? `${line}  ${style.paint("ok", `${style.glyphs.pointer} best`)}` : line;
  });
  const spent = ctx.priced ? [style.dim(`  spent ${formatUsd(result.spentUsd)}${ctx.capUsd !== undefined ? ` of ${formatUsd(ctx.capUsd)}` : ""} in total`)] : [];
  return [...rows, ...spent];
}

function row(a: Attempt, status: string, detail: string, now: number, ctx: BoardContext): string {
  const { style } = ctx;
  const elapsed = a.startedAt ? clock((a.endedAt ?? now) - a.startedAt) : "";
  const steps = a.steps > 0 ? `${a.steps} step${a.steps === 1 ? "" : "s"}` : "";
  const cost = ctx.priced && a.costUsd > 0 ? formatUsd(a.costUsd) : "";
  const left = [
    style.dim(padStart(`#${a.spec.n}`, 3)),
    padEnd(truncate(a.spec.model, MODEL_WIDTH), MODEL_WIDTH),
    padEnd(status, STATUS_WIDTH),
    style.dim(padStart(elapsed, 5)),
    style.dim(padStart(steps, 9)),
    ...(ctx.priced ? [style.dim(padStart(cost, 7))] : []),
  ].join(" ");
  const used = 3 + MODEL_WIDTH + STATUS_WIDTH + 5 + 9 + (ctx.priced ? 7 : 0) + (ctx.priced ? 6 : 5) + 2;
  const room = ctx.width - used;
  return room > 8 && detail ? `${left}  ${truncate(detail, room)}` : left;
}

function outcomeLabel(a: Attempt, ctx: BoardContext): string {
  const { style } = ctx;
  if (a.stopReason === "aborted") return style.dim("stopped");
  if (a.stopReason === "error") return style.paint("error", `${style.glyphs.cross} error`);
  if (a.check) {
    if (a.check.passed) return style.paint("ok", `${style.glyphs.check} passed`);
    return style.paint("error", `${style.glyphs.cross} ${a.check.timedOut ? "timed out" : `failed (${a.check.exitCode ?? "?"})`}`);
  }
  if (a.stopReason === "cost_limit") return style.paint("warn", "cap reached");
  if (a.files === 0) return style.dim("no changes");
  return qualifies(a, false) ? style.paint("ok", `${style.glyphs.check} done`) : style.paint("warn", "unverified");
}

function changeSummary(a: Attempt, style: Style): string {
  if (a.stopReason === "error") return truncate((a.error ?? "model error").split("\n")[0], 80);
  if (a.files === 0) return a.stopReason && a.stopReason !== "complete" ? describeStop(a.stopReason) : "";
  const text = `${a.files} file${a.files === 1 ? "" : "s"} +${a.insertions} ${style.glyphs.minus}${a.deletions}`;
  return a.stopReason && a.stopReason !== "complete" && a.stopReason !== "aborted" ? `${text} (${describeStop(a.stopReason)})` : text;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
