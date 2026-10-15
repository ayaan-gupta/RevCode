/**
 * "Don't ask again" that survives the session: the rule is written to the project's
 * `.revcode/config.local.json` (the personal, uncommitted layer of config) and that file is added
 * to `.git/info/exclude` so it cannot be committed by accident.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

export const LOCAL_CONFIG = path.join(".revcode", "config.local.json");

export function persistAllowRule(cwd: string, rule: string): { file: string; added: boolean } {
  const file = path.join(cwd, LOCAL_CONFIG);
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
    } catch {
      // A damaged local file is replaced rather than blocking the rule.
    }
  }
  const permissions = (config.permissions && typeof config.permissions === "object" && !Array.isArray(config.permissions) ? config.permissions : {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]).filter((r): r is string => typeof r === "string") : [];
  if (allow.includes(rule)) return { file, added: false };
  config.permissions = { ...permissions, allow: [...allow, rule] };

  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temp, file);
  excludeFromGit(cwd);
  return { file, added: true };
}

/** Add the local config to `.git/info/exclude` (never to a tracked .gitignore). */
function excludeFromGit(cwd: string): void {
  try {
    const gitDir = path.join(cwd, ".git");
    if (!existsSync(gitDir)) return;
    const exclude = path.join(gitDir, "info", "exclude");
    const entry = `/${LOCAL_CONFIG.replace(/\\/g, "/")}`;
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (current.split(/\r?\n/).includes(entry)) return;
    mkdirSync(path.dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${entry}\n`, "utf8");
  } catch {
    // `.git` may be a file (worktree) or read-only; the rule is still saved
  }
}
