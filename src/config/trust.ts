/**
 * Project trust.
 *
 * A repository can ship `.revcode/hooks.json` and `.mcp.json`, both of which make
 * RevCode run commands on the user's machine. Opening an unfamiliar repo must not
 * be enough to execute them, so project-defined hooks and MCP servers run only
 * for directories the user has explicitly trusted (one prompt, remembered).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { revcodeHome } from "./paths.js";

function trustFile(): string {
  return path.join(revcodeHome(), "trusted-projects.json");
}

function readTrusted(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(trustFile(), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** True when `dir` (or an ancestor) was trusted, or trust is forced via the environment. */
export function isProjectTrusted(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.REVCODE_TRUST_PROJECT === "1") {
    return true;
  }
  const target = path.resolve(dir);
  return readTrusted().some((trusted) => target === trusted || target.startsWith(trusted + path.sep));
}

export function trustProject(dir: string): void {
  const target = path.resolve(dir);
  const trusted = readTrusted();
  if (trusted.includes(target)) {
    return;
  }
  mkdirSync(path.dirname(trustFile()), { recursive: true });
  writeFileSync(trustFile(), `${JSON.stringify([...trusted, target], null, 2)}\n`, "utf8");
}

/** Project files that execute commands when RevCode loads them. */
export function projectExecutableConfigs(dir: string): string[] {
  const root = path.resolve(dir);
  return [
    path.join(root, ".revcode", "hooks.json"),
    path.join(root, ".revcode", "hooks.local.json"),
    path.join(root, ".mcp.json"),
    path.join(root, ".revcode", "mcp.json"),
  ].filter((file) => existsSync(file));
}
