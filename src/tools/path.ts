/**
 * Shared path helpers for sandboxed tool operations.
 *
 * By default tools are confined to the agent's working directory. Headless and
 * yolo runs (benchmarks, CI, disposable universes) pass `unrestricted` because
 * tasks legitimately name absolute paths elsewhere (/etc, /tmp, /usr/local…) and
 * a path-sandbox rejection there costs a whole run.
 */

import path from "node:path";

export interface PathPolicy {
  /** Allow absolute paths and `..` that leave the working directory. */
  unrestricted?: boolean;
}

export function resolvePathInsideCwd(inputPath: string, cwd: string, unrestricted = false): string {
  const resolved = path.resolve(cwd, inputPath);
  if (unrestricted) {
    return resolved;
  }
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Path escapes the working directory (${cwd}): ${inputPath}. Use a path inside it, or run RevCode with --yolo to allow absolute paths.`,
    );
  }

  return resolved;
}

export function formatRelativePath(filePath: string, cwd: string): string {
  return path.relative(cwd, filePath) || ".";
}
