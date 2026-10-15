/**
 * User and project configuration.
 *
 * Precedence, lowest to highest:
 *   ~/.revcode/config.json  <  <cwd>/.revcode/config.json  <  <cwd>/.revcode/config.local.json
 * and CLI flags override all of them (applied in cli.ts). A bad file never aborts
 * startup — it produces a warning and is skipped.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { revcodeHome } from "./paths.js";

export interface RevcodeConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  maxIterations?: number;
  /** Seconds. Enables time-budget nudges and a clean stop near the limit. */
  timeBudgetSec?: number;
  /** "auto" (use the tuned profile for the model, if any), "default", or a path to a profile JSON. */
  profile?: string;
  permissions?: {
    mode?: "ask" | "accept-edits" | "plan" | "yolo";
    allow?: string[];
    deny?: string[];
  };
  /** Run interactive sessions inside a Parallel Universe by default. */
  universe?: boolean;
  /** Collect the environment snapshot at startup. */
  snapshot?: boolean;
  mcp?: boolean;
  hooks?: boolean;
  /** Terminal colors: "auto" detects the background, or force "dark" / "light". */
  theme?: "auto" | "dark" | "light";
}

export interface LoadedConfig {
  config: RevcodeConfig;
  warnings: string[];
  files: string[];
}

const PERMISSION_MODES = new Set(["ask", "accept-edits", "plan", "yolo"]);

export function loadConfig(cwd: string): LoadedConfig {
  const candidates = [
    path.join(revcodeHome(), "config.json"),
    path.join(cwd, ".revcode", "config.json"),
    path.join(cwd, ".revcode", "config.local.json"),
  ];

  let merged: RevcodeConfig = {};
  const warnings: string[] = [];
  const files: string[] = [];

  for (const file of candidates) {
    if (!existsSync(file)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const { config, problems } = validateConfig(parsed);
      merged = mergeConfig(merged, config);
      files.push(file);
      warnings.push(...problems.map((problem) => `${file}: ${problem}`));
    } catch (error) {
      warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { config: merged, warnings, files };
}

export function validateConfig(raw: unknown): { config: RevcodeConfig; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: {}, problems: ["config must be a JSON object"] };
  }
  const input = raw as Record<string, unknown>;
  const config: RevcodeConfig = {};

  const str = (key: keyof RevcodeConfig): void => {
    if (input[key] === undefined) return;
    if (typeof input[key] === "string" && (input[key] as string).length > 0) {
      (config as Record<string, unknown>)[key] = input[key];
    } else {
      problems.push(`"${key}" must be a non-empty string`);
    }
  };
  const bool = (key: keyof RevcodeConfig): void => {
    if (input[key] === undefined) return;
    if (typeof input[key] === "boolean") {
      (config as Record<string, unknown>)[key] = input[key];
    } else {
      problems.push(`"${key}" must be true or false`);
    }
  };
  const positive = (key: keyof RevcodeConfig): void => {
    if (input[key] === undefined) return;
    if (typeof input[key] === "number" && Number.isFinite(input[key]) && (input[key] as number) > 0) {
      (config as Record<string, unknown>)[key] = input[key];
    } else {
      problems.push(`"${key}" must be a positive number`);
    }
  };

  str("provider");
  str("model");
  str("baseUrl");
  str("profile");
  if (input.theme !== undefined) {
    if (input.theme === "auto" || input.theme === "dark" || input.theme === "light") config.theme = input.theme;
    else problems.push('"theme" must be one of auto, dark, light');
  }
  positive("maxIterations");
  positive("timeBudgetSec");
  bool("universe");
  bool("snapshot");
  bool("mcp");
  bool("hooks");

  if (input.permissions !== undefined) {
    const perms = input.permissions as Record<string, unknown> | null;
    if (!perms || typeof perms !== "object" || Array.isArray(perms)) {
      problems.push('"permissions" must be an object');
    } else {
      config.permissions = {};
      if (perms.mode !== undefined) {
        if (typeof perms.mode === "string" && PERMISSION_MODES.has(perms.mode)) {
          config.permissions.mode = perms.mode as NonNullable<RevcodeConfig["permissions"]>["mode"];
        } else {
          problems.push('"permissions.mode" must be one of ask, accept-edits, plan, yolo');
        }
      }
      for (const key of ["allow", "deny"] as const) {
        const value = perms[key];
        if (value === undefined) continue;
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          config.permissions[key] = value as string[];
        } else {
          problems.push(`"permissions.${key}" must be an array of strings`);
        }
      }
    }
  }
  return { config, problems };
}

/** Later layers win; permission rule lists concatenate so deny rules are never lost. */
export function mergeConfig(base: RevcodeConfig, over: RevcodeConfig): RevcodeConfig {
  const permissions =
    base.permissions || over.permissions
      ? {
          mode: over.permissions?.mode ?? base.permissions?.mode,
          allow: [...(base.permissions?.allow ?? []), ...(over.permissions?.allow ?? [])],
          deny: [...(base.permissions?.deny ?? []), ...(over.permissions?.deny ?? [])],
        }
      : undefined;
  return { ...base, ...over, ...(permissions ? { permissions } : {}) };
}

/** Merge `patch` into the user-level config file (`~/.revcode/config.json`), creating it if needed. */
export function saveUserConfig(patch: Record<string, unknown>): string {
  const file = path.join(revcodeHome(), "config.json");
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch {
      // A broken file is replaced rather than blocking the setting.
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
  renameSync(temp, file);
  return file;
}
