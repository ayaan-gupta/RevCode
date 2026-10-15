/**
 * Persistent prompt history, one file per project (`~/.revcode/history/<project>.jsonl`),
 * so Up-arrow recalls what you typed *here*. Entries are JSON strings (multi-line prompts
 * survive), consecutive duplicates collapse, and the file is trimmed when it grows.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { revcodeHome, safeSegment } from "../config/paths.js";

const DEFAULT_MAX = 500;

export function historyFileFor(cwd: string): string {
  return path.join(revcodeHome(), "history", `${safeSegment(path.resolve(cwd))}.jsonl`);
}

export class HistoryStore {
  private items: string[] = [];
  private appended = 0;

  constructor(
    private readonly file: string | undefined,
    private readonly max = DEFAULT_MAX,
  ) {
    this.items = this.read();
  }

  /** Oldest first. */
  entries(): readonly string[] {
    return this.items;
  }

  add(entry: string): void {
    const text = entry.replace(/\s+$/, "");
    if (text.trim().length === 0) return;
    if (this.items.at(-1) === text) return;
    this.items.push(text);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.appended += 1;
      if (this.appended > this.max) {
        // Compact: rewrite with just what we keep.
        writeFileSync(this.file, `${this.items.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
        this.appended = 0;
      } else {
        appendFileSync(this.file, `${JSON.stringify(text)}\n`, "utf8");
      }
    } catch {
      // History is a convenience; never fail a prompt over it.
    }
  }

  private read(): string[] {
    if (!this.file || !existsSync(this.file)) return [];
    const out: string[] = [];
    try {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const value = JSON.parse(line) as unknown;
          if (typeof value === "string" && value.trim().length > 0 && out.at(-1) !== value) out.push(value);
        } catch {
          // skip a damaged line
        }
      }
    } catch {
      return [];
    }
    return out.slice(-this.max);
  }
}
