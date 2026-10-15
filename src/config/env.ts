/**
 * Environment files. Precedence: real environment > `./.env` > `~/.revcode/.env`, so a project can
 * override the key `revcode setup` saved for you, and CI can override both.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { revcodeHome } from "./paths.js";

export function userEnvFile(): string {
  return path.join(revcodeHome(), ".env");
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    if (key) out[key] = unquote(trimmed.slice(eq + 1).trim());
  }
  return out;
}

function applyFile(file: string): void {
  if (!existsSync(file)) return;
  try {
    for (const [key, value] of Object.entries(parseEnvText(readFileSync(file, "utf8")))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // an unreadable env file must never stop startup
  }
}

/** Load `./.env` then `~/.revcode/.env` without overriding anything already set. */
export function loadEnvFiles(cwd = process.cwd()): void {
  applyFile(path.resolve(cwd, ".env"));
  applyFile(userEnvFile());
}

/** Set `values` in `~/.revcode/.env` (created 0600), preserving every other line. */
export function saveUserEnv(values: Record<string, string>): string {
  const file = userEnvFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));
  const lines = existing.map((line) => {
    const key = line.replace(/^\s*export\s+/, "").split("=")[0]?.trim();
    if (key && pending.has(key) && line.includes("=")) {
      const value = pending.get(key) as string;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  writeFileSync(file, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort on filesystems without modes
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return file;
}
