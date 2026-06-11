/**
 * CLI argument parsing.
 *
 * TODO: integrate a proper arg parser (e.g. command-line-args or yargs)
 *       once we know the full flag surface.
 */

export interface CliArgs {
  /** Working directory for the agent. Defaults to cwd. */
  cwd: string;
  /** Model identifier (e.g. "claude-sonnet-4-20250514"). */
  model: string;
  /** Run in non-interactive / headless mode. */
  headless: boolean;
}

export function parseArgs(_argv: string[]): CliArgs {
  // TODO: parse --cwd, --model, --headless, etc.
  return {
    cwd: process.cwd(),
    model: "claude-sonnet-4-20250514",
    headless: false,
  };
}
