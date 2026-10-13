/**
 * Human-friendly formatting for tool calls and their results: compact "cards"
 * instead of raw JSON, and colored unified diffs for file mutations.
 */

import { dim, rgb } from "./ansi.js";
import { COLOR_CYAN, COLOR_PINK, COLOR_PURPLE } from "./theme.js";

const TOOL_ICONS: Record<string, string> = {
  shell: "$",
  read_file: "≡",
  write_file: "✎",
  edit_file: "✎",
  list_directory: "▸",
  grep: "⌕",
  glob: "⌕",
  delete_file: "✕",
  update_plan: "☑",
  apply_patch: "✎",
  edit_anchored: "✎",
  use_skill: "✦",
  task: "⑂",
};

/** A one-line, human-readable summary of a tool invocation. */
export function formatToolCall(name: string, args: Record<string, unknown>, rich: boolean): string {
  const icon = TOOL_ICONS[name] ?? "•";
  const summary = describeCall(name, args);
  const head = rich ? rgb(COLOR_PURPLE, `${icon} ${name}`) : `${icon} ${name}`;
  const detail = rich ? dim(summary) : summary;
  return summary ? `  ${head}  ${detail}` : `  ${head}`;
}

function describeCall(name: string, args: Record<string, unknown>): string {
  const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");
  switch (name) {
    case "shell": {
      const cmd = clip(str("command"), 100);
      return args.background ? `${cmd}  (background)` : cmd;
    }
    case "read_file":
      return str("path");
    case "write_file":
      return str("path");
    case "edit_file": {
      const edits = Array.isArray(args.edits) ? args.edits.length : 0;
      return `${str("path")}${edits ? `  (${edits} edit${edits === 1 ? "" : "s"})` : ""}`;
    }
    case "apply_patch": {
      const files = [...String(args.input ?? args.patch ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
      return files.length > 0 ? clip(files.join(", "), 100) : "patch";
    }
    case "edit_anchored":
      return str("path");
    case "use_skill":
      return str("name");
    case "task":
      return clip(str("description") || str("prompt"), 100);
    case "list_directory":
      return str("path");
    case "grep":
      return `"${clip(str("pattern"), 60)}"${str("path") ? ` in ${str("path")}` : ""}`;
    case "glob":
      return str("pattern");
    case "delete_file":
      return str("path");
    case "update_plan": {
      const steps = Array.isArray(args.steps) ? args.steps.length : 0;
      return `${steps} step${steps === 1 ? "" : "s"}`;
    }
    default:
      return clip(JSON.stringify(args), 100);
  }
}

/** Color a unified diff (as returned by write_file/edit_file). */
export function renderDiff(diff: string, rich: boolean): string {
  if (!rich) {
    return indent(diff);
  }
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return `    ${dim(line)}`;
      }
      if (line.startsWith("@@")) {
        return `    ${rgb(COLOR_CYAN, line)}`;
      }
      if (line.startsWith("+")) {
        return `    ${rgb([74, 222, 128], line)}`;
      }
      if (line.startsWith("-")) {
        return `    ${rgb(COLOR_PINK, line)}`;
      }
      return `    ${dim(line)}`;
    })
    .join("\n");
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/** Pull a unified diff out of a tool result if it carries one. */
export function extractDiff(result: unknown): string | undefined {
  if (typeof result === "string" && result.includes("@@")) {
    return result;
  }
  if (result && typeof result === "object") {
    const diff = (result as Record<string, unknown>).diff;
    if (typeof diff === "string" && diff.trim().length > 0) {
      return diff;
    }
  }
  return undefined;
}

export const ACCENT_PINK = COLOR_PINK;
