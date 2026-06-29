/**
 * Shared path helpers for sandboxed tool operations.
 */

import path from "node:path";

export function resolvePathInsideCwd(inputPath: string, cwd: string): string {
  const resolved = path.resolve(cwd, inputPath);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the working directory: ${inputPath}`);
  }

  return resolved;
}

export function formatRelativePath(filePath: string, cwd: string): string {
  return path.relative(cwd, filePath) || ".";
}
