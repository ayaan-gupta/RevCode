/**
 * MCP server configuration loading.
 *
 * Reads the de-facto standard `mcpServers` JSON shared by Claude Code, Cursor
 * and Claude Desktop so users can reuse the config files they already have:
 *
 *   { "mcpServers": {
 *       "fs":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *       "docs": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *       "old":  { "type": "sse",  "url": "https://example.com/sse" }
 *   } }
 *
 * Files are merged lowest to highest precedence, by server NAME (a later file's
 * entry replaces the earlier one wholesale — no deep merge, so a project can
 * never accidentally inherit half of a user-level server's arguments):
 *
 *   1. `$REVCODE_HOME/mcp.json` (default `~/.revcode/mcp.json`)  — user
 *   2. `<cwd>/.mcp.json`                                         — project, shared with other tools
 *   3. `<cwd>/.revcode/mcp.json`                                 — project, RevCode-specific
 *
 * Design notes:
 * - Loading NEVER throws. Config files are user-edited and frequently half
 *   broken; a typo in one server must not take down the agent, so every
 *   problem becomes an entry in `warnings` and the offending file/server is
 *   skipped.
 * - `${VAR}` and `${VAR:-default}` are expanded in command, args, env values,
 *   cwd, url and header values (never in keys). `:-` follows bash: the default
 *   applies when the variable is unset OR empty. A variable with no value and
 *   no default does not abort loading: the server is kept but flagged with
 *   `error`, so it shows up as "failed" with an actionable reason instead of
 *   silently running with an empty token or vanishing from the status list.
 * - `"disabled": true` keeps the entry (it is reported as "disabled"). A bare
 *   `{ "disabled": true }` in a higher-precedence file switches off a server
 *   defined in a lower one, which is how a project opts out of a user-level
 *   server without redefining it.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isRecord } from "./types.js";

export type McpTransportKind = "stdio" | "http" | "sse";

interface McpServerConfigBase {
  /** Key in `mcpServers`. */
  name: string;
  /** Server is configured but must not be started. */
  disabled: boolean;
  /** Per-request timeout override (ms) for this server. */
  timeoutMs?: number;
  /** Startup (handshake + first tools/list) timeout override (ms). */
  startupTimeoutMs?: number;
  /** Absolute path of the file this entry came from (highest precedence wins). */
  source: string;
  /**
   * Set when the entry could not be fully resolved (e.g. an unset `${VAR}`).
   * The manager reports such a server as failed without starting it.
   */
  error?: string;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Absolute working directory; when absent the manager uses the project cwd. */
  cwd?: string;
}

export interface McpRemoteServerConfig extends McpServerConfigBase {
  /** `http` = Streamable HTTP, `sse` = legacy HTTP+SSE. */
  type: "http" | "sse";
  url: string;
  headers: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface LoadedMcpConfig {
  servers: McpServerConfig[];
  /** Human-readable problems found while loading (never fatal). */
  warnings: string[];
  /** Config files that existed and were read, lowest precedence first. */
  sources: string[];
}

export interface LoadMcpConfigOptions {
  /** Environment used for `REVCODE_HOME` and `${VAR}` expansion. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Home directory fallback when `REVCODE_HOME` is unset. Defaults to `os.homedir()`. */
  homeDir?: string;
}

/** The three config file locations, lowest precedence first. */
export function mcpConfigPaths(cwd: string, options: LoadMcpConfigOptions = {}): string[] {
  const env = options.env ?? process.env;
  const override = env.REVCODE_HOME;
  const home =
    override !== undefined && override.length > 0
      ? path.resolve(override)
      : path.join(options.homeDir ?? os.homedir(), ".revcode");
  const root = path.resolve(cwd);
  return [path.join(home, "mcp.json"), path.join(root, ".mcp.json"), path.join(root, ".revcode", "mcp.json")];
}

/** Load and merge every MCP config file. Never throws; problems land in `warnings`. */
export async function loadMcpConfig(
  cwd: string,
  options: LoadMcpConfigOptions = {},
): Promise<LoadedMcpConfig> {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const sources: string[] = [];
  // A Map (not a plain object) so a server named "__proto__" is just a key.
  const merged = new Map<string, McpServerConfig>();

  for (const file of mcpConfigPaths(cwd, options)) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        warnings.push(`${file}: could not read MCP config: ${errorMessage(error)}`);
      }
      continue;
    }
    sources.push(file);

    let json: unknown;
    try {
      json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
      warnings.push(`${file}: invalid JSON, ignoring this file: ${errorMessage(error)}`);
      continue;
    }

    const parsed = parseMcpConfig(json, { source: file, cwd: path.resolve(cwd), env });
    warnings.push(...parsed.warnings);
    for (const entry of parsed.entries) {
      if (entry.kind === "disable") {
        const existing = merged.get(entry.name);
        if (existing) {
          merged.set(entry.name, { ...existing, disabled: true, source: file });
        }
        continue;
      }
      merged.set(entry.config.name, entry.config);
    }
  }

  return { servers: [...merged.values()], warnings, sources };
}

export type ParsedMcpEntry =
  | { kind: "server"; config: McpServerConfig }
  /** `{ "disabled": true }` without a usable definition: only meaningful as an override. */
  | { kind: "disable"; name: string };

export interface ParseMcpConfigContext {
  /** File the JSON came from (used in warnings and `source`). */
  source: string;
  /** Project directory; relative `cwd` values resolve against it. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Validate one parsed config document. Exported for tests; prefer `loadMcpConfig`. */
export function parseMcpConfig(
  json: unknown,
  context: ParseMcpConfigContext,
): { entries: ParsedMcpEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const entries: ParsedMcpEntry[] = [];
  const { source } = context;

  if (!isRecord(json)) {
    warnings.push(`${source}: expected a JSON object at the top level, ignoring this file.`);
    return { entries, warnings };
  }
  const servers = json.mcpServers;
  if (servers === undefined) {
    warnings.push(`${source}: no "mcpServers" key found; nothing to load from this file.`);
    return { entries, warnings };
  }
  if (!isRecord(servers)) {
    warnings.push(`${source}: "mcpServers" must be an object mapping server names to configs.`);
    return { entries, warnings };
  }

  for (const [name, raw] of Object.entries(servers)) {
    if (name.trim() === "") {
      warnings.push(`${source}: ignoring a server with an empty name.`);
      continue;
    }
    try {
      const entry = parseServerEntry(name, raw, context, warnings);
      if (entry) {
        entries.push(entry);
      }
    } catch (error) {
      if (error instanceof ConfigEntryError) {
        if (isRecord(raw) && raw.disabled === true) {
          // A disabled server that is also malformed is not worth a warning;
          // it still acts as an override that switches off a lower-level entry.
          entries.push({ kind: "disable", name });
        } else {
          warnings.push(`${source}: server "${name}" skipped: ${error.message}`);
        }
        continue;
      }
      throw error;
    }
  }
  return { entries, warnings };
}

class ConfigEntryError extends Error {}

function parseServerEntry(
  name: string,
  raw: unknown,
  context: ParseMcpConfigContext,
  warnings: string[],
): ParsedMcpEntry | undefined {
  if (!isRecord(raw)) {
    throw new ConfigEntryError("expected an object.");
  }
  if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") {
    throw new ConfigEntryError('"disabled" must be true or false.');
  }
  const disabled = raw.disabled === true;

  // `{ "disabled": true }` alone is an override stub, not a server definition.
  if (disabled && raw.command === undefined && raw.url === undefined) {
    return { kind: "disable", name };
  }

  const kind = resolveKind(raw);
  const missing = new Set<string>();
  const expand = (value: string): string => expandEnv(value, context.env, missing);

  const base = {
    name,
    disabled,
    source: context.source,
    ...optionalTimeouts(raw, name, context.source, warnings),
  };

  let config: McpServerConfig;
  if (kind === "stdio") {
    if (typeof raw.command !== "string" || raw.command.trim() === "") {
      throw new ConfigEntryError('stdio servers need a non-empty string "command".');
    }
    const args = raw.args === undefined ? [] : scalarList(raw.args, '"args"');
    const env = raw.env === undefined ? {} : scalarRecord(raw.env, '"env"');
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
      throw new ConfigEntryError('"cwd" must be a string.');
    }
    const cwd = typeof raw.cwd === "string" ? path.resolve(context.cwd, expand(raw.cwd)) : undefined;
    config = {
      ...base,
      type: "stdio",
      command: expand(raw.command),
      args: args.map(expand),
      env: mapValues(env, expand),
      ...(cwd !== undefined ? { cwd } : {}),
    };
  } else {
    if (typeof raw.url !== "string" || raw.url.trim() === "") {
      throw new ConfigEntryError(`${kind} servers need a non-empty string "url".`);
    }
    const headers = raw.headers === undefined ? {} : scalarRecord(raw.headers, '"headers"');
    const url = expand(raw.url.trim());
    // Only validate the URL after expansion succeeded; an unresolved variable
    // is reported through `error` below, which is the more useful message.
    if (missing.size === 0) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ConfigEntryError(`"url" is not a valid URL: ${url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ConfigEntryError(`"url" must use http or https, got ${parsed.protocol}`);
      }
    }
    config = {
      ...base,
      type: kind,
      url,
      headers: mapValues(headers, expand),
    };
  }

  if (missing.size > 0 && !disabled) {
    const vars = [...missing].sort();
    const error = `environment variable${vars.length > 1 ? "s" : ""} ${vars.join(", ")} not set (referenced in the server config; use \${VAR:-default} to provide a fallback)`;
    config.error = error;
    warnings.push(`${context.source}: server "${name}": ${error}`);
  }
  return { kind: "server", config };
}

function resolveKind(raw: Record<string, unknown>): McpTransportKind {
  const declared = raw.type;
  if (declared !== undefined) {
    if (typeof declared !== "string") {
      throw new ConfigEntryError('"type" must be a string.');
    }
    switch (declared.toLowerCase()) {
      case "stdio":
        return "stdio";
      case "http":
      case "streamable-http":
      case "streamablehttp":
        return "http";
      case "sse":
        return "sse";
      default:
        throw new ConfigEntryError(`unsupported "type" "${declared}" (expected stdio, http or sse).`);
    }
  }
  if (typeof raw.command === "string") {
    return "stdio";
  }
  if (typeof raw.url === "string") {
    // Cursor-style configs omit `type`. A path ending in /sse is the legacy
    // transport's conventional endpoint; everything else is Streamable HTTP.
    try {
      return new URL(raw.url).pathname.replace(/\/+$/, "").endsWith("/sse") ? "sse" : "http";
    } catch {
      return "http";
    }
  }
  throw new ConfigEntryError('needs either "command" (stdio) or "url" (http/sse).');
}

function optionalTimeouts(
  raw: Record<string, unknown>,
  name: string,
  source: string,
  warnings: string[],
): { timeoutMs?: number; startupTimeoutMs?: number } {
  const out: { timeoutMs?: number; startupTimeoutMs?: number } = {};
  for (const key of ["timeoutMs", "startupTimeoutMs"] as const) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
    } else {
      warnings.push(`${source}: server "${name}": "${key}" must be a positive number of milliseconds; ignoring it.`);
    }
  }
  return out;
}

/** An array of strings (numbers/booleans are stringified, since `"args": ["--port", 8080]` is common). */
function scalarList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigEntryError(`${label} must be an array.`);
  }
  return value.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      return String(item);
    }
    throw new ConfigEntryError(`${label} may only contain strings.`);
  });
}

function scalarRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new ConfigEntryError(`${label} must be an object of string values.`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    } else if (typeof item === "number" || typeof item === "boolean") {
      out[key] = String(item);
    } else {
      throw new ConfigEntryError(`${label}.${key} must be a string.`);
    }
  }
  return out;
}

function mapValues(record: Record<string, string>, fn: (value: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = fn(value);
  }
  return out;
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand `${VAR}` and `${VAR:-default}`. Names of variables that were unset
 * (or empty) and had no default are added to `missing` and expand to "".
 * The default may not contain `}`; nested expansion is not supported.
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv, missing?: Set<string>): string {
  return value.replace(ENV_PATTERN, (_match, name: string, fallback: string | undefined) => {
    const current = env[name];
    if (fallback !== undefined) {
      return current !== undefined && current !== "" ? current : fallback;
    }
    if (current === undefined) {
      missing?.add(name);
      return "";
    }
    return current;
  });
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
