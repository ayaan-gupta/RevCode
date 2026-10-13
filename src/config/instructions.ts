/**
 * Project instruction discovery (AGENTS.md and friends).
 *
 * Instruction files are layered from the most general to the most specific:
 *   ~/.revcode/AGENTS.md  →  <git root>/AGENTS.md  →  …  →  <cwd>/AGENTS.md
 * so a nested package can refine repo-wide guidance. Per directory the first of
 * AGENTS.md / CLAUDE.md wins (repos often symlink one to the other), and
 * REVCODE.md is additive for RevCode-only notes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { revcodeHome } from "./paths.js";

const PRIMARY_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
const ADDITIVE_NAMES = ["REVCODE.md"] as const;
const MAX_FILE_CHARS = 16_000;
const MAX_TOTAL_CHARS = 32_000;
const MAX_DEPTH = 12;

export interface LoadedInstructions {
  text: string;
  /** Absolute paths of the files that contributed, outermost first. */
  files: string[];
}

export function loadInstructions(cwd: string): LoadedInstructions {
  const files: string[] = [];
  const parts: string[] = [];
  let total = 0;

  const add = (file: string, label: string): void => {
    if (files.includes(file) || total >= MAX_TOTAL_CHARS) {
      return;
    }
    const content = readCapped(file);
    if (content === undefined) {
      return;
    }
    const remaining = MAX_TOTAL_CHARS - total;
    const clipped = content.length > remaining ? `${content.slice(0, remaining)}\n…(truncated)` : content;
    files.push(file);
    parts.push(`## ${label}\n${clipped.trim()}`);
    total += clipped.length;
  };

  const globalFile = path.join(revcodeHome(), "AGENTS.md");
  add(globalFile, "~/.revcode/AGENTS.md");

  for (const dir of directoriesOutermostFirst(path.resolve(cwd))) {
    const primary = PRIMARY_NAMES.map((name) => path.join(dir, name)).find((file) => isFile(file));
    if (primary) {
      add(primary, relativeLabel(primary, cwd));
    }
    for (const name of ADDITIVE_NAMES) {
      const file = path.join(dir, name);
      if (isFile(file)) {
        add(file, relativeLabel(file, cwd));
      }
    }
  }

  return { text: parts.join("\n\n"), files };
}

/** Directories from the git root (or a bounded ancestor) down to cwd. */
export function directoriesOutermostFirst(cwd: string): string[] {
  const chain: string[] = [];
  let dir = cwd;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    chain.push(dir);
    if (existsSync(path.join(dir, ".git"))) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // No git root found: only trust cwd itself, not arbitrary ancestors.
  const hitRoot = existsSync(path.join(chain[chain.length - 1], ".git"));
  return (hitRoot ? chain : [cwd]).reverse();
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readCapped(file: string): string | undefined {
  if (!isFile(file)) {
    return undefined;
  }
  try {
    const text = readFileSync(file, "utf8");
    if (text.trim().length === 0) {
      return undefined;
    }
    return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n…(truncated)` : text;
  } catch {
    return undefined;
  }
}

function relativeLabel(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  return rel.startsWith("..") ? file : rel || path.basename(file);
}
