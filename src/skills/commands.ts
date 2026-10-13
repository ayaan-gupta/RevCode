/**
 * Custom slash commands: markdown prompt templates in `commands/` directories.
 *
 * `.revcode/commands/review.md` becomes `/review`; `.revcode/commands/git/pr.md`
 * becomes `/git:pr`. The body is a prompt with `$ARGUMENTS` (the raw argument
 * string) and `$1`..`$9` (shell-style split arguments). Skills are exposed
 * through the same {@link CustomCommand} shape (see `skillToCommand`) so the
 * host has a single lookup-and-expand path for everything that expands to a
 * prompt.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { asString, parseFrontmatter } from "./frontmatter.js";
import { searchRoots, type DiscoveryOptions } from "./roots.js";

export interface CustomCommand {
  /** Slash name without the leading `/`; nested files use `dir:name`. */
  name: string;
  description: string;
  /** Shown after the name in help, e.g. `<issue-number>`. */
  argumentHint?: string;
  /** Prompt body with `$ARGUMENTS` / `$1`..`$9` placeholders. */
  template: string;
  /** Absolute path of the defining file. */
  file: string;
  source: "command" | "skill";
  scope: "user" | "project";
}

export interface CommandDiscovery {
  commands: CustomCommand[];
  warnings: string[];
}

const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_DEPTH = 5;
const SEGMENT = "[A-Za-z0-9_][A-Za-z0-9_.-]*";
const COMMAND_NAME = new RegExp(`^${SEGMENT}(?::${SEGMENT})*$`);
const MAX_DESCRIPTION = 200;

/** Find every custom command visible from `cwd`; nearer/project definitions override outer ones. */
export function discoverCommands(cwd: string, options: DiscoveryOptions = {}): CommandDiscovery {
  const warnings: string[] = [];
  const byName = new Map<string, { command: CustomCommand; rootIndex: number }>();

  searchRoots(cwd, "commands", options).forEach((root, rootIndex) => {
    for (const file of listMarkdownFiles(root.dir, warnings)) {
      const command = loadCommand(file.absolute, file.segments, root.scope, warnings);
      if (!command) {
        continue;
      }
      const existing = byName.get(command.name);
      if (existing && existing.rootIndex === rootIndex) {
        warnings.push(`Duplicate command "${command.name}" in ${root.dir}: ignoring ${file.absolute}`);
        continue;
      }
      byName.set(command.name, { command, rootIndex });
    }
  });

  const commands = [...byName.values()].map((entry) => entry.command);
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { commands, warnings };
}

/**
 * Turn a command into the prompt to send to the model. Arguments with no
 * placeholder to land in are appended, so `/fix the flaky test` never silently
 * drops what the user typed.
 */
export function expandCommand(command: CustomCommand, argsString: string): string {
  // Skill bodies are shell-heavy (`awk '{print $1}'`), so only $ARGUMENTS is live for them.
  return expandTemplate(command.template, argsString, { positional: command.source !== "skill" });
}

export function expandTemplate(
  template: string,
  argsString: string,
  options: { positional?: boolean } = {},
): string {
  const args = argsString.trim();
  const positional = options.positional !== false;
  const words = positional ? splitArgs(args) : [];

  let substituted = false;
  // One pass: substituted text is never rescanned, so an argument containing "$1" stays literal.
  const expanded = template.replace(/\$ARGUMENTS\b|\$([1-9])(?!\d)/g, (match, digit: string | undefined) => {
    if (digit === undefined) {
      substituted = true;
      return args;
    }
    if (!positional) {
      return match;
    }
    substituted = true;
    return words[Number(digit) - 1] ?? "";
  });
  return substituted || args === "" ? expanded : `${expanded}\n\nARGUMENTS: ${args}`;
}

/**
 * Split an argument string like a shell would, minus the sharp edges: double
 * quotes group anywhere, single quotes only group at the start of a word (so
 * "don't touch it" stays four words), and backslashes are literal outside
 * double quotes (Windows paths).
 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else if (ch === "\\" && quote === '"' && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        i += 1;
        current += input[i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || (ch === "'" && !inWord)) {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) {
        out.push(current);
        current = "";
        inWord = false;
      }
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) {
    out.push(current);
  }
  return out;
}

/**
 * Recognize `/name rest of line`. Returns undefined for anything that is not a
 * command invocation, including absolute paths (`/usr/bin/env x`) and `//`.
 */
export function parseSlashInput(line: string): { name: string; args: string } | undefined {
  const match = /^\s*\/([A-Za-z0-9_][\w.:-]*)(?:\s+([\s\S]*))?$/.exec(line);
  if (!match) {
    return undefined;
  }
  return { name: match[1], args: (match[2] ?? "").trim() };
}

/** Exact match first, then case-insensitive, so `/Review` still finds `review`. */
export function findCommand(commands: readonly CustomCommand[], name: string): CustomCommand | undefined {
  const wanted = name.replace(/^\//, "");
  return (
    commands.find((command) => command.name === wanted) ??
    commands.find((command) => command.name.toLowerCase() === wanted.toLowerCase())
  );
}

// --- loading --------------------------------------------------------------------

interface CommandFile {
  absolute: string;
  /** Directory names plus the basename without `.md`. */
  segments: string[];
}

function listMarkdownFiles(root: string, warnings: string[]): CommandFile[] {
  const files: CommandFile[] = [];

  const walk = (dir: string, prefix: string[], depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
        warnings.push(`Cannot read commands directory ${dir}: ${errorMessage(error)}`);
      }
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) {
        continue;
      }
      const absolute = path.join(dir, name);
      let isDirectory: boolean;
      let isFile: boolean;
      try {
        // stat (not lstat) so symlinked command files and directories work.
        const stat = statSync(absolute);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
      if (isDirectory && depth < MAX_DEPTH) {
        walk(absolute, [...prefix, name], depth + 1);
      } else if (isFile && name.toLowerCase().endsWith(".md")) {
        files.push({ absolute, segments: [...prefix, name.slice(0, -3)] });
      }
    }
  };

  walk(root, [], 0);
  return files;
}

function loadCommand(
  file: string,
  segments: string[],
  scope: "user" | "project",
  warnings: string[],
): CustomCommand | undefined {
  const name = segments.join(":");
  if (!COMMAND_NAME.test(name)) {
    warnings.push(`Skipping command file ${file}: "${name}" is not a valid command name (use letters, digits, _ . -)`);
    return undefined;
  }

  let source: string;
  try {
    if (statSync(file).size > MAX_COMMAND_BYTES) {
      warnings.push(`Skipping command ${file}: larger than ${MAX_COMMAND_BYTES / 1024} KiB`);
      return undefined;
    }
    source = readFileSync(file, "utf8");
  } catch (error) {
    warnings.push(`Cannot read command ${file}: ${errorMessage(error)}`);
    return undefined;
  }

  const parsed = parseFrontmatter(source);
  if (parsed.error) {
    warnings.push(`Skipping command ${file}: ${parsed.error}`);
    return undefined;
  }
  const template = parsed.body.trim();
  if (template === "") {
    warnings.push(`Skipping command ${file}: empty prompt`);
    return undefined;
  }

  const description =
    asString(parsed.data.description)?.trim() || firstLine(template) || `Run the ${name} command`;
  const argumentHint = asString(parsed.data["argument-hint"])?.trim();
  return {
    name,
    description: description.slice(0, MAX_DESCRIPTION),
    ...(argumentHint ? { argumentHint } : {}),
    template,
    file,
    source: "command",
    scope,
  };
}

/** First non-empty line with markdown heading markers removed, as a fallback description. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const cleaned = line.replace(/^#+\s*/, "").trim();
    if (cleaned !== "") {
      return cleaned;
    }
  }
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
