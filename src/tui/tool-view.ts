/**
 * Tool calls as compact cards: a header saying what ran, then a summary and a short preview of
 * the result (command output, a diff, match counts) — detailed enough to follow along, short
 * enough not to bury the conversation. Ctrl+O toggles a longer preview.
 */

import { renderDiffView } from "./diff-view.js";
import { formatDuration, plural, sanitizeForDisplay } from "./fmt.js";
import type { Style } from "./style.js";
import { truncate, visibleWidth } from "./width.js";

export interface ToolCardOptions {
  style: Style;
  /** Content width; the card is indented by the caller. */
  width: number;
  verbose: boolean;
  durationMs?: number;
}

interface Call {
  name: string;
  arguments: Record<string, unknown>;
}

const TITLES: Record<string, string> = {
  shell: "Run",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  apply_patch: "Edit",
  edit_anchored: "Edit",
  delete_file: "Delete",
  list_directory: "List",
  grep: "Search",
  glob: "Find",
  update_plan: "Plan",
  task: "Agent",
  use_skill: "Skill",
  terminal: "Terminal",
  view_image: "View image",
};

const EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "edit_anchored"]);

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");

function oneLine(text: string, max: number): string {
  const single = sanitizeForDisplay(text).replace(/\s+/g, " ").trim();
  return truncate(single, max);
}

/** Friendly tool name and the key argument, for card headers. */
export function describeCall(call: Call, max = 100): { title: string; detail: string } {
  const { name } = call;
  const args = call.arguments ?? {};
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  const title = mcp ? `${mcp[1]} ${"›"} ${mcp[2]}` : (TITLES[name] ?? name);
  let detail = "";
  switch (name) {
    case "shell": {
      const command = str(args, "command");
      detail = oneLine(command.split("\n")[0], max) + (command.includes("\n") ? " …" : "");
      if (args.background) detail += "  (background)";
      break;
    }
    case "read_file": {
      detail = str(args, "path");
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      if (offset !== undefined || limit !== undefined) detail += ` (${offset ?? 1}${limit ? `–${(offset ?? 1) + limit - 1}` : "+"})`;
      break;
    }
    case "write_file":
    case "edit_file":
    case "edit_anchored":
    case "delete_file":
    case "list_directory":
      detail = str(args, "path");
      break;
    case "apply_patch": {
      const text = String(args.input ?? args.patch ?? "");
      const files = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
      detail = files.length > 0 ? oneLine(files.join(", "), max) : "patch";
      break;
    }
    case "grep":
      detail = `"${oneLine(str(args, "pattern"), 60)}"${str(args, "path") ? ` in ${str(args, "path")}` : ""}`;
      break;
    case "glob":
      detail = str(args, "pattern");
      break;
    case "update_plan":
      detail = plural(Array.isArray(args.steps) ? args.steps.length : 0, "step");
      break;
    case "task":
      detail = oneLine(str(args, "description") || str(args, "prompt"), max);
      break;
    case "use_skill":
      detail = str(args, "name");
      break;
    case "view_image":
      detail = str(args, "path");
      break;
    case "terminal":
      detail = oneLine(`${str(args, "action")} ${str(args, "command") || str(args, "text") || str(args, "session")}`, max);
      break;
    default:
      detail = oneLine(JSON.stringify(args), max);
  }
  return { title, detail: truncate(detail, max) };
}

/** Short label for the "Running …" activity line. */
export function activityLabel(call: Call): string {
  const { title, detail } = describeCall(call, 60);
  return detail ? `${title.toLowerCase()}: ${detail}` : title.toLowerCase();
}

type Outcome = "ok" | "error" | "denied";

/** The model-facing refusal text, reworded for the person who made the decision. */
export function userFacingDenial(message: string): string {
  const said = /and said: "([\s\S]*?)"\. Do not retry/.exec(message);
  if (said) return `you said: "${said[1]}"`;
  if (/^The user declined/.test(message)) return "you declined this action";
  if (/^Plan mode is read-only/.test(message)) return "plan mode is read-only (Shift+Tab or /plan to leave it)";
  return message;
}

function classify(result: unknown): { outcome: Outcome; message?: string } {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.length > 0) {
      return { outcome: record.denied === true ? "denied" : "error", message: record.error };
    }
  }
  return { outcome: "ok" };
}

function previewRows(text: string, limit: number, style: Style, width: number, mode: "head" | "headtail" = "headtail"): string[] {
  const lines = sanitizeForDisplay(text).split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  const clip = (line: string): string => (visibleWidth(line) > width ? truncate(line, width) : line);
  if (lines.length <= limit) return lines.map((l) => style.dim(clip(l)));
  if (mode === "head") {
    const head = lines.slice(0, limit);
    return [...head.map((l) => style.dim(clip(l))), style.dim(`${style.glyphs.ellipsis} +${lines.length - limit} more lines`)];
  }
  const tail = Math.max(1, Math.floor(limit / 2));
  const head = limit - tail;
  const hidden = lines.length - limit;
  return [
    ...lines.slice(0, head).map((l) => style.dim(clip(l))),
    style.dim(`${style.glyphs.ellipsis} +${hidden} more lines`),
    ...lines.slice(lines.length - tail).map((l) => style.dim(clip(l))),
  ];
}

/** Rows for one finished tool call (header first). */
export function renderToolCard(call: Call, result: unknown, options: ToolCardOptions): string[] {
  const { style, width, verbose } = options;
  const { title, detail } = describeCall(call, Math.max(20, width - 8));
  const { outcome, message } = classify(result);
  const bulletRole = outcome === "ok" ? "ok" : outcome === "denied" ? "warn" : "error";
  const header = `${style.paint(bulletRole, style.glyphs.bullet)} ${style.bold(title)}${detail ? `  ${style.paint("accent", detail)}` : ""}`;
  const rows: string[] = [header];
  const lead = `  ${style.dim(style.glyphs.result)} `;
  const pad = "    ";
  const textWidth = Math.max(20, width - 4);
  const rowLimit = verbose ? 40 : 6;
  const timing = options.durationMs !== undefined && options.durationMs >= 1000 ? ` ${style.glyphs.dot} ${formatDuration(options.durationMs)}` : "";

  if (outcome !== "ok") {
    const text = sanitizeForDisplay(outcome === "denied" ? userFacingDenial(message ?? "declined") : (message ?? "failed")).trim();
    const lines = text.split("\n");
    const shown = lines.slice(0, verbose ? 12 : 3);
    const label = outcome === "denied" ? "Not run" : "Failed";
    const role = outcome === "denied" ? "warn" : "error";
    rows.push(`${lead}${style.paint(role, `${label}:`)} ${truncate(shown[0] ?? "", textWidth - label.length - 2)}`);
    for (const extra of shown.slice(1)) rows.push(`${pad}${style.dim(truncate(extra, textWidth))}`);
    if (lines.length > shown.length) rows.push(`${pad}${style.dim(`${style.glyphs.ellipsis} +${lines.length - shown.length} more lines`)}`);
    return rows;
  }

  const summarize = (text: string, role?: "ok" | "error" | "warn"): void => {
    rows.push(`${lead}${role ? style.paint(role, text) : text}${style.dim(timing)}`);
  };
  const addPreview = (text: string, limit = rowLimit, mode: "head" | "headtail" = "headtail"): void => {
    for (const row of previewRows(text, limit, style, textWidth, mode)) rows.push(`${pad}${row}`);
  };
  const addDiff = (diff: string): void => {
    const view = renderDiffView(diff, { style, width: textWidth, maxRows: verbose ? 80 : 14 });
    for (const row of view.rows) rows.push(`${pad}${row}`);
  };

  const record = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;

  switch (call.name) {
    case "shell": {
      if (record.background && typeof record.background === "object") {
        const bg = record.background as { pid?: number | null; logFile?: string };
        summarize(`started in background${bg.pid ? ` (pid ${bg.pid})` : ""}`);
        return rows;
      }
      const code = typeof record.exitCode === "number" ? record.exitCode : undefined;
      const parts = [code === undefined ? "finished" : `exit ${code}`];
      if (record.timedOut) parts.push("timed out");
      if (record.sessionReset) parts.push("shell restarted");
      summarize(parts.join(` ${style.glyphs.dot} `), code === 0 && !record.timedOut ? "ok" : "error");
      const output = typeof record.stdout === "string" ? record.stdout : "";
      if (output.trim().length > 0) addPreview(output, rowLimit, "headtail");
      if (record.truncated) rows.push(`${pad}${style.dim("output truncated; the model can read the rest from a file")}`);
      return rows;
    }
    case "read_file": {
      const content = typeof record.content === "string" ? record.content : "";
      const shown = content.length === 0 ? 0 : content.split("\n").length;
      const total = typeof record.totalLines === "number" ? record.totalLines : shown;
      const partial = typeof record.continuation === "string" || (total > 0 && shown < total);
      summarize(total === 0 ? "empty or non-text file" : partial ? `Read ${shown} of ${total} lines` : `Read ${plural(shown, "line")}`);
      if (verbose && shown > 0) addPreview(content, 12, "head");
      return rows;
    }
    case "write_file": {
      const created = record.created === true;
      const diff = typeof record.diff === "string" ? record.diff : "";
      const view = diff ? renderDiffView(diff, { style, width: textWidth, maxRows: verbose ? 80 : 14 }) : undefined;
      summarize(`${created ? "Created" : "Wrote"}${view ? ` (+${view.added} ${style.glyphs.minus}${view.removed})` : ""}`, "ok");
      if (view) for (const row of view.rows) rows.push(`${pad}${row}`);
      return rows;
    }
    case "edit_file":
    case "edit_anchored":
    case "apply_patch": {
      const text = typeof result === "string" ? result : typeof record.diff === "string" ? record.diff : "";
      const stat = /\(([^)]*;\s*)?\+(\d+)\s+-(\d+)\)/.exec(text.split("\n")[0] ?? "");
      const files = call.name === "apply_patch" ? [...text.matchAll(/^[AMD] (.+)$/gm)].length : 0;
      const summary = stat ? `+${stat[2]} ${style.glyphs.minus}${stat[3]}` : files > 0 ? `updated ${plural(files, "file")}` : "applied";
      summarize(summary, "ok");
      const diffStart = text.search(/^--- /m);
      for (const line of text.split("\n").slice(1)) {
        if (/^Note:/.test(line)) rows.push(`${pad}${style.paint("warn", truncate(sanitizeForDisplay(line), textWidth))}`);
      }
      if (diffStart >= 0) addDiff(text.slice(diffStart));
      return rows;
    }
    case "delete_file":
      summarize("Deleted", "ok");
      return rows;
    case "list_directory": {
      const entries = Array.isArray(record.entries) ? (record.entries as string[]) : [];
      summarize(plural(entries.length, "entry", "entries"));
      if (verbose) addPreview(entries.join("\n"), 20, "head");
      return rows;
    }
    case "glob": {
      const matches = Array.isArray(record.matches) ? (record.matches as string[]) : [];
      summarize(matches.length === 0 ? "no files" : plural(matches.length, "file"));
      if (matches.length > 0) addPreview(matches.join("\n"), verbose ? 30 : 4, "head");
      return rows;
    }
    case "grep": {
      const matches = typeof record.matches === "string" ? record.matches : "";
      const none = matches.trim() === "(no matches)" || matches.trim() === "";
      const lines = none ? [] : matches.split("\n").filter((l) => l.trim().length > 0);
      summarize(none ? "no matches" : plural(lines.length, "line"));
      if (!none) addPreview(matches, verbose ? 30 : 4, "head");
      return rows;
    }
    case "task": {
      const report = typeof record.report === "string" ? record.report : "";
      const parts = [typeof record.toolCalls === "number" ? plural(record.toolCalls, "tool call") : "done"];
      if (typeof record.durationMs === "number") parts.push(formatDuration(record.durationMs));
      summarize(parts.join(` ${style.glyphs.dot} `));
      if (report) addPreview(report, verbose ? 24 : 3, "head");
      return rows;
    }
    case "view_image": {
      const answer = typeof record.answer === "string" ? record.answer : "";
      summarize("Image analyzed");
      if (answer) addPreview(answer, verbose ? 16 : 3, "head");
      return rows;
    }
    case "use_skill":
      summarize("Loaded", "ok");
      return rows;
    case "terminal": {
      const screen = typeof record.screen === "string" ? record.screen : "";
      summarize(record.alive === false ? "session ended" : "ok");
      if (screen.trim()) addPreview(screen, verbose ? 24 : 5, "headtail");
      return rows;
    }
    default: {
      let text: string;
      if (typeof result === "string") text = result;
      else if (typeof record.content === "string") text = record.content;
      else if (typeof record.text === "string") text = record.text;
      else if (typeof record.report === "string") text = record.report;
      else text = result === undefined ? "" : JSON.stringify(result);
      summarize(text.trim().length === 0 ? "done" : plural(text.split("\n").length, "line"));
      if (text.trim().length > 0) addPreview(text, verbose ? 24 : 4, "head");
      return rows;
    }
  }
}

/** True for tools whose approval prompt should show a diff of what will change. */
export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}
