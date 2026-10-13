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
