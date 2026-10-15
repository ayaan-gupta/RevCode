/**
 * `@path/to/file` mentions: inline the referenced files so the model sees their
 * contents without spending a tool call. Only existing, readable, text files
 * inside the working directory are expanded; anything else is left as typed.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MAX_FILE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 60_000;
const MENTION = /(^|\s)@([\w./\\-][^\s,;:!?()[\]{}'"`]*)/g;

export interface ExpandedMentions {
  text: string;
  files: string[];
}

export function expandMentions(text: string, cwd: string): ExpandedMentions {
  const files: string[] = [];
  const blocks: string[] = [];
  let total = 0;

  for (const match of text.matchAll(MENTION)) {
    const rel = match[2].replace(/[.]+$/, "");
    if (files.includes(rel)) continue;
    const resolved = path.resolve(cwd, rel);
    const within = path.relative(cwd, resolved);
    if (within.startsWith("..") || path.isAbsolute(within)) continue;
    try {
      if (!existsSync(resolved) || !statSync(resolved).isFile()) continue;
      const buffer = readFileSync(resolved);
      if (buffer.subarray(0, 8000).includes(0)) continue;
      let content = buffer.toString("utf8");
      if (content.length > MAX_FILE_CHARS) {
        content = `${content.slice(0, MAX_FILE_CHARS)}\n…(truncated; read_file for the rest)`;
      }
      if (total + content.length > MAX_TOTAL_CHARS) continue;
      total += content.length;
      files.push(rel);
      blocks.push(`<file path="${rel}">\n${content}\n</file>`);
    } catch {
      // unreadable: leave the mention as plain text
    }
  }

  return blocks.length === 0 ? { text, files } : { text: `${text}\n\n${blocks.join("\n\n")}`, files };
}

/**
 * Dragging a file into the terminal pastes its path (often quoted or with escaped spaces).
 * When the paste is exactly one existing file, turn it into an `@mention` so the contents are
 * attached; a path outside the project is returned plainly so the model can still open it.
 */
export function pastedPathToMention(pasted: string, cwd: string): string | undefined {
  let text = pasted.trim();
  if (text.length === 0 || text.length > 600 || text.includes("\n")) return undefined;
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) text = text.slice(1, -1);
  if (text.startsWith("file://")) {
    try {
      text = decodeURIComponent(text.slice("file://".length));
    } catch {
      return undefined;
    }
  }
  text = text.replace(/\\ /g, " ");
  if (text.startsWith("~/") && process.env.HOME) text = path.join(process.env.HOME, text.slice(2));
  if (!text.startsWith("/") && !text.startsWith("./") && !text.startsWith("../")) return undefined;
  const absolute = path.resolve(cwd, text);
  try {
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const relative = path.relative(cwd, absolute);
  const inside = !relative.startsWith("..") && !path.isAbsolute(relative);
  if (inside && !/\s/.test(relative)) return `@${relative} `;
  return /\s/.test(absolute) ? `"${absolute}" ` : `${absolute} `;
}
