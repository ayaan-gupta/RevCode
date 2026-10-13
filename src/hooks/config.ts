/**
 * Hook configuration: the JSON shape Claude Code uses, so existing hook
 * scripts and snippets carry over.
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "shell|edit_file",
 *       "hooks": [ { "type": "command", "command": "...", "timeout": 30 } ] } ] } }
 *
 * Files are merged by concatenation (global, project, project-local), so every
 * layer's hooks run, in that order. Parsing never throws: bad entries are
 * dropped with a warning so one typo cannot disable the other hooks (or the
 * agent).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { revcodeHome } from "../config/paths.js";

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookCommandSpec {
  type: "command";
  command: string;
  /** Seconds (fractions allowed). Defaults to {@link DEFAULT_HOOK_TIMEOUT_SECONDS}. */
  timeout?: number;
}

export interface HookMatcherGroup {
  /** Regex tested against the tool name; omitted, "" or "*" matches every tool. */
  matcher?: string;
  hooks: HookCommandSpec[];
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcherGroup[]>>;

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;
export const MAX_HOOK_TIMEOUT_SECONDS = 600;

export interface ParsedHooks {
  config: HooksConfig;
  warnings: string[];
}

export interface LoadHooksOptions {
  /** Replaces `revcodeHome()` for the global file (tests). */
  revcodeHome?: string;
  /**
   * Read `<cwd>/.revcode/hooks*.json`. Pass false for a repository the user has
   * not trusted: those files run arbitrary shell commands.
   */
  includeProject?: boolean;
}

/** Validate the parsed contents of one hooks file. `source` labels warnings. */
export function parseHooksFile(raw: unknown, source: string): ParsedHooks {
  const warnings: string[] = [];
  const config: HooksConfig = {};

  if (!isRecord(raw)) {
    return { config, warnings: [`${source}: expected a JSON object like {"hooks": {...}}`] };
  }
  if (raw.hooks === undefined) {
    return { config, warnings };
  }
  if (!isRecord(raw.hooks)) {
    return { config, warnings: [`${source}: "hooks" must be an object keyed by event name`] };
  }

  for (const [event, groups] of Object.entries(raw.hooks)) {
    if (!isHookEvent(event)) {
      warnings.push(`${source}: unknown hook event "${event}" (known: ${HOOK_EVENTS.join(", ")})`);
      continue;
    }
    if (!Array.isArray(groups)) {
      warnings.push(`${source}: hooks.${event} must be an array`);
      continue;
    }
    const valid: HookMatcherGroup[] = [];
    groups.forEach((group, index) => {
      const parsed = parseGroup(group, `${source}: hooks.${event}[${index}]`, warnings);
      if (parsed) {
        valid.push(parsed);
      }
    });
    if (valid.length > 0) {
      config[event] = valid;
    }
  }
  return { config, warnings };
}

/** Concatenate per event, preserving argument order. */
export function mergeHooksConfigs(configs: readonly HooksConfig[]): HooksConfig {
  const merged: HooksConfig = {};
  for (const config of configs) {
    for (const event of HOOK_EVENTS) {
      const groups = config[event];
      if (groups && groups.length > 0) {
        merged[event] = [...(merged[event] ?? []), ...groups];
      }
    }
  }
  return merged;
}

/** Read and merge `~/.revcode/hooks.json`, `<cwd>/.revcode/hooks.json`, `<cwd>/.revcode/hooks.local.json`. */
export function loadHooksConfig(cwd: string, options: LoadHooksOptions = {}): ParsedHooks {
  const files = [path.join(options.revcodeHome ?? revcodeHome(), "hooks.json")];
  if (options.includeProject !== false) {
    files.push(path.join(cwd, ".revcode", "hooks.json"), path.join(cwd, ".revcode", "hooks.local.json"));
  }

  const warnings: string[] = [];
  const configs: HooksConfig[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        warnings.push(`${file}: cannot read hooks file (${errorMessage(error)})`);
      }
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      warnings.push(`${file}: invalid JSON (${errorMessage(error)})`);
      continue;
    }
    const parsed = parseHooksFile(raw, file);
    configs.push(parsed.config);
    warnings.push(...parsed.warnings);
  }
  return { config: mergeHooksConfigs(configs), warnings };
}

const regexCache = new Map<string, RegExp | null>();

/**
 * Does `matcher` select `toolName`? Unanchored, like a regex test: a hook on
 * `shell` also covers `shell_background`, which errs toward running a guard
 * hook rather than silently missing a tool. An invalid pattern matches nothing
 * (it is also rejected with a warning at load time).
 */
export function matcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") {
    return true;
  }
  return compileMatcher(matcher)?.test(toolName) ?? false;
}

function compileMatcher(matcher: string): RegExp | null {
  const cached = regexCache.get(matcher);
  if (cached !== undefined) {
    return cached;
  }
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(matcher);
  } catch {
    compiled = null;
  }
  regexCache.set(matcher, compiled);
  return compiled;
}

// --- validation -------------------------------------------------------------------

function parseGroup(group: unknown, label: string, warnings: string[]): HookMatcherGroup | undefined {
  if (!isRecord(group)) {
    warnings.push(`${label}: expected an object with a "hooks" array`);
    return undefined;
  }
  if (group.matcher !== undefined && typeof group.matcher !== "string") {
    warnings.push(`${label}: "matcher" must be a string; skipping this entry`);
    return undefined;
  }
  if (typeof group.matcher === "string" && compileMatcher(group.matcher) === null) {
    warnings.push(`${label}: invalid matcher regex "${group.matcher}"; skipping this entry`);
    return undefined;
  }
  if (!Array.isArray(group.hooks)) {
    warnings.push(`${label}: "hooks" must be an array of {type, command} objects`);
    return undefined;
  }

  const hooks: HookCommandSpec[] = [];
  group.hooks.forEach((hook, index) => {
    const parsed = parseCommand(hook, `${label}.hooks[${index}]`, warnings);
    if (parsed) {
      hooks.push(parsed);
    }
  });
  if (hooks.length === 0) {
    return undefined;
  }
  return { ...(group.matcher !== undefined ? { matcher: group.matcher } : {}), hooks };
}

function parseCommand(hook: unknown, label: string, warnings: string[]): HookCommandSpec | undefined {
  if (!isRecord(hook)) {
    warnings.push(`${label}: expected an object`);
    return undefined;
  }
  if (hook.type !== undefined && hook.type !== "command") {
    warnings.push(`${label}: unsupported hook type "${String(hook.type)}" (only "command")`);
    return undefined;
  }
  if (typeof hook.command !== "string" || hook.command.trim() === "") {
    warnings.push(`${label}: "command" must be a non-empty string`);
    return undefined;
  }

  let timeout: number | undefined;
  if (hook.timeout !== undefined) {
    if (typeof hook.timeout === "number" && Number.isFinite(hook.timeout) && hook.timeout > 0) {
      timeout = Math.min(hook.timeout, MAX_HOOK_TIMEOUT_SECONDS);
    } else {
      warnings.push(`${label}: "timeout" must be a positive number of seconds; using ${DEFAULT_HOOK_TIMEOUT_SECONDS}`);
    }
  }
  return { type: "command", command: hook.command, ...(timeout !== undefined ? { timeout } : {}) };
}

function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
