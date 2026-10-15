/**
 * Input completion: slash commands (and their arguments) and `@file` mentions.
 *
 * `createCompleter` returns a pure function the editor calls after every change; file
 * candidates come from a cached index of the project (git-aware) that loads in the
 * background so typing never blocks.
 */

import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

export interface CompletionItem {
  /** What the menu shows. */
  label: string;
  /** What replaces the typed token when accepted. */
  insert: string;
  description?: string;
  kind: "command" | "file" | "dir" | "value";
  /** Text appended after the insertion (a space for finished tokens, nothing for directories). */
  append: string;
  /** For commands that need no arguments: Enter accepts *and* submits. */
  submitOnEnter?: boolean;
}

export interface CompletionResult {
  items: CompletionItem[];
  /** Range of the input to replace when an item is accepted. */
  start: number;
  end: number;
}

export type Completer = (text: string, cursor: number) => CompletionResult | undefined;

export interface SlashCommandInfo {
  command: string;
  description: string;
  /** Argument hint shown in help, e.g. "[name]". */
  args?: string;
  /** Possible values for the first argument (offered after `/cmd `). */
  values?: () => string[];
}

const MAX_ITEMS = 50;

// --- fuzzy ranking -------------------------------------------------------------------

/** Score how well `query` matches `candidate` (higher is better, -1 = no match). */
export function fuzzyScore(query: string, candidate: string): number {
  if (query.length === 0) return 1;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const base = c.slice(c.lastIndexOf("/", c.length - 2) + 1);

  if (base.startsWith(q)) return 1000 - Math.min(base.length, 200);
  if (c.startsWith(q)) return 900 - Math.min(c.length, 200);
  const baseIndex = base.indexOf(q);
  if (baseIndex !== -1) return 700 - baseIndex;
  const pathIndex = c.indexOf(q);
  if (pathIndex !== -1) return 500 - Math.min(pathIndex, 200);

  // Subsequence match, rewarding contiguity and word-start hits.
  let score = 0;
  let last = -2;
  let at = 0;
  for (const ch of q) {
    const found = c.indexOf(ch, at);
    if (found === -1) return -1;
    score += found === last + 1 ? 8 : 1;
    if (found === 0 || "/._-".includes(c[found - 1])) score += 6;
    last = found;
    at = found + 1;
  }
  return Math.min(300, score) - c.length / 100;
}

export function rankByFuzzy<T>(query: string, items: readonly T[], key: (item: T) => string, limit = MAX_ITEMS): T[] {
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query, key(item));
    if (score >= 0) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.item);
}

// --- file index ----------------------------------------------------------------------

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", "__pycache__", ".venv", "venv", ".next", ".cache", "coverage"]);
const MAX_FILES = 20_000;

export class FileIndex {
  private files: string[] = [];
  private dirs: string[] = [];
  private loading: Promise<void> | undefined;
  private loaded = false;

  constructor(private readonly cwd: string) {}

  /** Start (or reuse) the background load. */
  load(): Promise<void> {
    this.loading ??= this.populate().then(
      () => {
        this.loaded = true;
      },
      () => {
        this.loaded = true;
      },
    );
    return this.loading;
  }

  get ready(): boolean {
    return this.loaded;
  }

  /** Candidate paths (files and directories with a trailing slash). */
  entries(): string[] {
    return [...this.dirs, ...this.files];
  }

  /** For tests and callers that already have the list. */
  setFiles(files: string[]): void {
    this.files = files.slice(0, MAX_FILES);
    this.dirs = deriveDirs(this.files);
    this.loaded = true;
  }

  private async populate(): Promise<void> {
    const listed = await gitListFiles(this.cwd);
    this.setFiles(listed ?? walkFiles(this.cwd));
  }
}

function deriveDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    let dir = path.posix.dirname(file);
    while (dir !== "." && dir !== "/" && !dirs.has(`${dir}/`)) {
      dirs.add(`${dir}/`);
      dir = path.posix.dirname(dir);
    }
  }
  return [...dirs].sort();
}

function gitListFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, timeout: 4000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve(undefined);
          return;
        }
        const files = stdout.split("\0").filter((f) => f.length > 0);
        resolve(files.length > 0 ? files : undefined);
      },
    );
  });
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const rel = queue.shift() as string;
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}

// --- completer -----------------------------------------------------------------------

export interface CompleterOptions {
  commands: () => readonly SlashCommandInfo[];
  files?: FileIndex;
}

const MENTION_TOKEN = /(^|\s)@([^\s@]*)$/;

export function createCompleter(options: CompleterOptions): Completer {
  return (text, cursor) => {
    const before = text.slice(0, cursor);

    // @file mention: the token being typed, preceded by start or whitespace.
    const mention = MENTION_TOKEN.exec(before);
    if (mention && options.files) {
      const query = mention[2];
      const start = before.length - query.length - 1;
      return fileCompletions(options.files, query, start, cursor);
    }

    // /command or its first argument — only at the start of the input.
    if (!before.startsWith("/")) return undefined;
    const space = before.search(/\s/);
    if (space === -1) {
      const matches = commandMatches(options.commands(), before);
      if (matches.length === 0) return undefined;
      return {
        start: 0,
        end: cursor,
        items: matches.map((cmd) => ({
          label: cmd.command + (cmd.args ? ` ${cmd.args}` : ""),
          insert: cmd.command,
          description: cmd.description,
          kind: "command" as const,
          append: " ",
          submitOnEnter: !cmd.args,
        })),
      };
    }

    const name = before.slice(0, space);
    const command = options.commands().find((c) => c.command === name);
    const values = command?.values?.();
    if (!values || values.length === 0) return undefined;
    const argStart = space + 1;
    const typed = before.slice(argStart);
    if (/\s/.test(typed)) return undefined;
    const matches = rankByFuzzy(typed, values, (v) => v);
    if (matches.length === 0 || (matches.length === 1 && matches[0] === typed)) return undefined;
    return {
      start: argStart,
      end: cursor,
      items: matches.map((value) => ({ label: value, insert: value, kind: "value" as const, append: "" })),
    };
  };
}

function commandMatches(commands: readonly SlashCommandInfo[], typed: string): SlashCommandInfo[] {
  const needle = typed.toLowerCase();
  const prefix = commands.filter((c) => c.command.toLowerCase().startsWith(needle));
  if (prefix.length > 0 || needle.length <= 1) return needle.length <= 1 ? [...commands] : prefix;
  // No prefix match: fall back to substring/fuzzy so "/cmpct" still finds "/compact".
  return rankByFuzzy(needle.slice(1), commands, (c) => c.command.slice(1), 12);
}

function fileCompletions(index: FileIndex, query: string, start: number, end: number): CompletionResult | undefined {
  if (!index.ready) {
    void index.load();
    return undefined;
  }
  const candidates = index.entries();
  // Browsing a directory ("@src/") lists its direct children first.
  const matches = query.endsWith("/")
    ? candidates.filter((c) => c.startsWith(query) && c.slice(query.length).replace(/\/$/, "").indexOf("/") === -1 && c !== query)
    : rankByFuzzy(query, candidates, (c) => c, 40);
  if (matches.length === 0) return undefined;
  return {
    start,
    end,
    items: matches.map((entry) => {
      const isDir = entry.endsWith("/");
      return {
        label: entry,
        insert: `@${entry}`,
        kind: isDir ? ("dir" as const) : ("file" as const),
        append: isDir ? "" : " ",
      };
    }),
  };
}
