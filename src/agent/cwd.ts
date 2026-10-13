import { statSync } from "node:fs";

/** A reason the agent cannot work in `cwd`, or undefined when it is a usable directory. */
export function workingDirectoryProblem(cwd: string): string | undefined {
  try {
    return statSync(cwd).isDirectory() ? undefined : `--cwd is not a directory: ${cwd}`;
  } catch {
    return `--cwd does not exist: ${cwd}`;
  }
}
