/**
 * Tool: execute a shell command.
 *
 * TODO: implement. Should run commands in a sandboxed subprocess,
 *       stream stdout/stderr, enforce a timeout, and truncate large output.
 */

export interface ShellToolInput {
  command: string;
  timeout?: number;
  cwd?: string;
}

export interface ShellToolOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execShell(_input: ShellToolInput): Promise<ShellToolOutput> {
  throw new Error("shell tool not yet implemented");
}
