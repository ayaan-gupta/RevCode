/**
 * The permission prompt.
 *
 * A modal in the prompt area (not a line of text in the scrollback): what is about to happen,
 * a preview of the change for edits, and three choices — yes, yes-and-don't-ask-again, or no
 * with a chance to tell the model what to do instead. Single keys (y / a / n, 1-3) answer
 * immediately; Esc declines.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ApprovalDecision, ApprovalRequest } from "../agent/permissions.js";
import { generateDiff } from "../utils/diff.js";
import { renderDiffView } from "./diff-view.js";
import { sanitizeForDisplay } from "./fmt.js";
import { describeCall } from "./tool-view.js";
import type { TerminalRenderer } from "./render.js";
import { truncate, wrapAnsi } from "./width.js";

const MAX_PREVIEW_BYTES = 1_000_000;

function readText(file: string): string | undefined {
  try {
    if (!existsSync(file)) return "";
    if (statSync(file).size > MAX_PREVIEW_BYTES) return undefined;
    const buffer = readFileSync(file);
    if (buffer.subarray(0, 8000).includes(0)) return undefined;
    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}

/** Unified diff of what an edit tool call would do, or undefined when we cannot tell. */
export function previewDiffFor(tool: string, args: Record<string, unknown>, cwd: string): string | undefined {
  const rel = typeof args.path === "string" ? args.path : undefined;
  if (!rel) return undefined;
  const file = path.resolve(cwd, rel);
  const current = readText(file);
  if (current === undefined) return undefined;

  if (tool === "write_file" && typeof args.content === "string") {
    return generateDiff(current, args.content, rel, { maxLines: 200 });
  }
  if (tool === "edit_file") {
    const raw = Array.isArray(args.edits) ? args.edits : args.edits && typeof args.edits === "object" ? [args.edits] : [];
    let next = current;
    let exact = true;
    for (const edit of raw as Array<Record<string, unknown>>) {
      const oldText = typeof edit.oldText === "string" ? edit.oldText : undefined;
      const newText = typeof edit.newText === "string" ? edit.newText : undefined;
      if (oldText === undefined || newText === undefined || oldText.length === 0) return undefined;
      if (!next.includes(oldText)) {
        exact = false;
        break;
      }
      next = edit.replaceAll === true ? next.split(oldText).join(newText) : next.replace(oldText, () => newText);
    }
    if (exact && next !== current) return generateDiff(current, next, rel, { maxLines: 200 });
    // The tool matches fuzzily; show the requested change on its own.
    const first = (raw as Array<Record<string, unknown>>)[0];
    if (first && typeof first.oldText === "string" && typeof first.newText === "string") {
      return generateDiff(first.oldText, first.newText, rel, { maxLines: 200 });
    }
  }
  return undefined;
}

/** apply_patch carries its own diff-like text; colour it instead of re-deriving a diff. */
function patchRows(patch: string, renderer: TerminalRenderer, maxRows: number): string[] {
  const { style } = renderer;
  const rows: string[] = [];
  for (const raw of sanitizeForDisplay(patch).split("\n")) {
    if (raw.startsWith("*** Begin") || raw.startsWith("*** End") || raw.trim() === "") continue;
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(raw);
    if (file) rows.push(style.bold(`${file[1]} ${file[2]}`));
    else if (raw.startsWith("+")) rows.push(style.paint("diffAdd", raw));
    else if (raw.startsWith("-")) rows.push(style.paint("diffDel", raw));
    else if (raw.startsWith("@@")) rows.push(style.paint("accent", raw));
    else rows.push(style.dim(raw));
  }
  if (rows.length > maxRows) return [...rows.slice(0, maxRows - 1), style.dim(`${style.glyphs.ellipsis} +${rows.length - maxRows + 1} more lines`)];
  return rows;
}

export interface ApproverOptions {
  renderer: TerminalRenderer;
  cwd: () => string;
  /** Esc on the prompt: decline *and* stop the running task. */
  onCancel?: () => void;
}

/** Build the rows shown above the options. */
export function approvalTitle(request: ApprovalRequest, options: ApproverOptions, previewRows: number): string[] {
  const { renderer } = options;
  const { style } = renderer;
  const width = renderer.contentWidth();
  const rows: string[] = [];
  const edit = ["write_file", "edit_file", "apply_patch", "edit_anchored", "delete_file"].includes(request.tool);
  const question = request.tool === "shell" ? "Run this command?" : edit ? "Make this change?" : `${request.reason.replace(/\.$/, "")}?`;
  rows.push(`${style.paint("warn", style.glyphs.warn)} ${style.bold(question)}`);

  if (request.tool === "shell") {
    const command = sanitizeForDisplay(String(request.args.command ?? request.summary));
    const lines = command.split("\n");
    const shown = lines.slice(0, 8);
    shown.forEach((line, i) => rows.push(`  ${i === 0 ? style.dim("$ ") : "  "}${style.paint("accent", truncate(line, width - 4))}`));
    if (lines.length > shown.length) rows.push(style.dim(`    ${style.glyphs.ellipsis} +${lines.length - shown.length} more lines`));
  } else {
    const { title, detail } = describeCall({ name: request.tool, arguments: request.args }, width - 6);
    const text = detail ? `${style.bold(title)}  ${style.paint("accent", detail)}` : sanitizeForDisplay(request.summary);
    for (const line of wrapAnsi(text, width - 2)) rows.push(`  ${line}`);
  }

  if (previewRows > 2) {
    if (request.tool === "apply_patch") {
      const patch = String(request.args.input ?? request.args.patch ?? "");
      for (const row of patchRows(patch, renderer, previewRows)) rows.push(`  ${row}`);
    } else {
      const diff = previewDiffFor(request.tool, request.args, options.cwd());
      if (diff) {
        const view = renderDiffView(diff, { style, width: width - 2, maxRows: previewRows });
        for (const row of view.rows) rows.push(`  ${row}`);
      }
    }
  }
  return rows;
}

export function createTerminalApprover(options: ApproverOptions): (request: ApprovalRequest) => Promise<ApprovalDecision> {
  const { renderer } = options;
  return async (request) => {
    const { ui } = renderer;
    if (!ui.interactive) return { answer: "deny" };
    const rowsAvailable = Math.max(8, (process.stdout.rows ?? 24) - 12);
    const title = approvalTitle(request, options, Math.min(16, rowsAvailable));
    const always = request.alwaysLabel ?? "Yes, and don't ask again";
    const choice = await ui.select({
      title,
      options: [{ label: "Yes" }, { label: always }, { label: "No, and tell RevCode what to do differently" }],
      hotkeys: { y: 0, a: 1, n: 2 },
      footer: "↑↓ to move · enter to select · y / a / n · esc to stop the task",
    });
    if (choice === 0) return { answer: "allow" };
    if (choice === 1) return { answer: "always" };
    if (choice === 2) {
      const feedback = await ui.prompt({
        title: [renderer.style.bold("What should RevCode do instead?"), renderer.style.dim("  (optional — press Enter to just decline)")],
        optional: true,
        footer: "enter to send · esc to decline without a note",
      });
      return { answer: "deny", feedback: feedback?.trim() || undefined };
    }
    options.onCancel?.();
    return { answer: "deny" };
  };
}

/** A yes/no question (project trust, landing or discarding a universe). */
export async function confirmYesNo(renderer: TerminalRenderer, question: string, detail?: string[]): Promise<boolean> {
  const { ui, style } = renderer;
  if (!ui.interactive) return false;
  const title = [`${style.paint("warn", style.glyphs.warn)} ${style.bold(question)}`, ...(detail ?? []).map((line) => `  ${line}`)];
  const choice = await ui.select({
    title,
    options: [{ label: "Yes" }, { label: "No" }],
    hotkeys: { y: 0, n: 1 },
    cancelIndex: 1,
    footer: "enter to select · y / n · esc to cancel",
  });
  return choice === 0;
}
