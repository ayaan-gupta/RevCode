/**
 * Filesystem locations RevCode owns. Everything lives under one home
 * directory so it is trivial to inspect, back up, or delete.
 */

import os from "node:os";
import path from "node:path";

/** `~/.revcode`, overridable with `REVCODE_HOME` (used by tests and CI). */
export function revcodeHome(): string {
  const override = process.env.REVCODE_HOME;
  return override && override.length > 0 ? path.resolve(override) : path.join(os.homedir(), ".revcode");
}

export function profilesDir(): string {
  return path.join(revcodeHome(), "profiles");
}

export function sessionsDir(): string {
  return path.join(revcodeHome(), "sessions");
}

export function universesDir(): string {
  return path.join(revcodeHome(), "universes");
}

/** Make a string safe to use as a single path segment. */
export function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 120) || "_";
}
