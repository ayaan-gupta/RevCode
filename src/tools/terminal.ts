/**
 * Tool: terminal — drive interactive programs through a real terminal (tmux).
 *
 * `shell` runs commands non-interactively with stdin closed, which is right for
 * almost everything but useless for REPLs, editors, debuggers, installers that
 * ask questions, and text games. This tool starts such a program in a detached
 * tmux session, lets the model type into it (literal text and named keys), and
 * returns what is on the screen — the same model of interaction the Terminus
 * agents use, exposed as a tool.
 *
 * Sessions live on a private tmux socket, so a user's own tmux is never touched,
 * and the whole server is killed on dispose.
 */

import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TERMINAL_TOOL_NAME = "terminal";

const DEFAULT_WIDTH = 160;
const DEFAULT_HEIGHT = 50;
const SETTLE_MS = 350;
const DEFAULT_WAIT_MS = 2_000;
const MAX_WAIT_MS = 30_000;
const MAX_SCREEN_CHARS = 12_000;

export interface TerminalInput {
  action: "start" | "send" | "read" | "kill" | "list";
  session?: string;
  /** start: the program to run (default: an interactive bash). */
  command?: string;
  /** send: literal text typed into the program. */
  text?: string;
  /** send: named keys pressed after the text, e.g. ["Enter"], ["C-c"], ["Escape", ":", "w", "q", "Enter"]. */
  keys?: string[];
  /** read/send: also include this many lines of scrollback above the screen. */
  scrollback?: number;
  /** send/start: max time to wait for output to settle (ms). */
  wait_ms?: number;
}

export interface TerminalResult {
  session?: string;
  screen?: string;
  alive?: boolean;
  exitCode?: number | null;
  sessions?: string[];
  note?: string;
}

export function isTmuxAvailable(): boolean {
  try {
    return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export class TerminalManager {
  private readonly socket = `revcode-${process.pid}-${randomBytes(3).toString("hex")}`;
  private readonly sessions = new Set<string>();
  private serverStarted = false;

  constructor(private readonly cwd: string) {}

  async execute(input: TerminalInput): Promise<TerminalResult> {
    switch (input.action) {
      case "start":
        return this.start(input);
      case "send":
        return this.send(input);
      case "read":
        return this.read(input);
      case "kill":
        return this.kill(input);
      case "list":
        return { sessions: [...this.sessions] };
      default:
        throw new Error(`terminal: unknown action "${String((input as { action?: unknown }).action)}" (expected start, send, read, kill, list)`);
    }
  }

  private async start(input: TerminalInput): Promise<TerminalResult> {
    const name = sessionName(input.session);
    if (this.sessions.has(name)) {
      throw new Error(`terminal session "${name}" already exists; send to it, read it, or kill it first`);
    }
    const command = input.command?.trim() || "bash --norc --noprofile -i";
    await this.tmux([
      "new-session", "-d", "-s", name, "-x", String(DEFAULT_WIDTH), "-y", String(DEFAULT_HEIGHT), "-c", this.cwd,
      "env", "TERM=xterm-256color", "PS1=$ ", "bash", "-c", command,
    ]);
    this.serverStarted = true;
    this.sessions.add(name);
    // Keep the pane around after the program exits so its final output and status can be read.
    await this.tmux(["set-option", "-t", name, "remain-on-exit", "on"]).catch(() => undefined);
    return this.snapshot(name, input.wait_ms ?? DEFAULT_WAIT_MS, input.scrollback);
  }

  private async send(input: TerminalInput): Promise<TerminalResult> {
    const name = this.requireSession(input.session);
    const text = input.text ?? "";
    const keys = input.keys ?? [];
    if (text === "" && keys.length === 0) {
      throw new Error("terminal send requires text and/or keys");
    }
    if (text !== "") {
      await this.tmux(["send-keys", "-t", name, "-l", "--", text]);
    }
    for (const key of keys) {
      await this.tmux(["send-keys", "-t", name, "--", key]);
    }
    return this.snapshot(name, input.wait_ms ?? DEFAULT_WAIT_MS, input.scrollback);
  }

  private async read(input: TerminalInput): Promise<TerminalResult> {
    const name = this.requireSession(input.session);
    return this.snapshot(name, 0, input.scrollback);
  }

  private async kill(input: TerminalInput): Promise<TerminalResult> {
    const name = this.requireSession(input.session);
    await this.tmux(["kill-session", "-t", name]).catch(() => undefined);
    this.sessions.delete(name);
    return { session: name, alive: false, note: "session closed" };
  }

  /** Wait for the screen to stop changing, then return it. */
  private async snapshot(name: string, waitMs: number, scrollback?: number): Promise<TerminalResult> {
    const limit = Math.min(Math.max(waitMs, 0), MAX_WAIT_MS);
    const deadline = Date.now() + limit;
    let previous = "";
    let stableSince = Date.now();
    let screen = await this.capture(name, scrollback);
    if (limit > 0) {
      previous = screen;
      while (Date.now() < deadline) {
        await sleep(100);
        screen = await this.capture(name, scrollback);
        if (screen !== previous) {
          previous = screen;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= SETTLE_MS) {
          break;
        }
      }
    }

    const state = await this.paneState(name);
    // A mostly empty terminal is 50 blank rows; collapse long blank runs to save tokens.
    const trimmed = clip(screen.replace(/\s+$/g, "").replace(/\n{4,}/g, "\n\n"));
    return {
      session: name,
      screen: trimmed === "" ? "(blank screen)" : trimmed,
      alive: !state.dead,
      ...(state.dead ? { exitCode: state.exitCode, note: "the program has exited" } : {}),
    };
  }

  private async capture(name: string, scrollback?: number): Promise<string> {
    const args = ["capture-pane", "-p", "-J", "-t", name];
    if (scrollback && scrollback > 0) {
      args.push("-S", `-${Math.min(scrollback, 2000)}`);
    }
    const { stdout } = await this.tmux(args);
    return stdout;
  }

  private async paneState(name: string): Promise<{ dead: boolean; exitCode: number | null }> {
    // tmux flips pane_dead a moment before it records the exit status, so when the
    // pane is dead but the status is still empty, give it a few short retries.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const { stdout } = await this.tmux(["display-message", "-p", "-t", name, "#{pane_dead} #{pane_dead_status}"]);
        const [dead, status] = stdout.trim().split(" ");
        if (dead !== "1") {
          return { dead: false, exitCode: null };
        }
        if (status !== undefined && status !== "") {
          return { dead: true, exitCode: Number(status) };
        }
      } catch {
        return { dead: true, exitCode: null };
      }
      await sleep(60);
    }
    return { dead: true, exitCode: null };
  }

  private requireSession(session: string | undefined): string {
    const name = sessionName(session);
    if (!this.sessions.has(name)) {
      throw new Error(
        `no terminal session "${name}"${this.sessions.size > 0 ? ` (open: ${[...this.sessions].join(", ")})` : "; start one with action:\"start\""}`,
      );
    }
    return name;
  }

  private async tmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync("tmux", ["-L", this.socket, ...args], { cwd: this.cwd, encoding: "utf8", timeout: 15_000 });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
      throw new Error(`tmux ${args[0]} failed: ${detail}`);
    }
  }

  dispose(): void {
    if (!this.serverStarted) {
      return;
    }
    try {
      spawnSync("tmux", ["-L", this.socket, "kill-server"], { stdio: "ignore", timeout: 5_000 });
    } catch {
      // already gone
    }
    this.sessions.clear();
    this.serverStarted = false;
  }
}

function sessionName(session: string | undefined): string {
  const name = (session ?? "main").trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) {
    throw new Error(`invalid terminal session name "${name}" (use letters, digits, - and _)`);
  }
  return name;
}

function clip(text: string): string {
  return text.length <= MAX_SCREEN_CHARS ? text : `${text.slice(0, MAX_SCREEN_CHARS / 2)}\n[… screen truncated …]\n${text.slice(-MAX_SCREEN_CHARS / 2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const terminalToolDefinition = {
  name: TERMINAL_TOOL_NAME,
  description:
    "Drive an INTERACTIVE program through a real terminal: REPLs (python3, node), editors (vim, nano), debuggers (gdb, pdb), installers that ask questions, text games. Use shell for everything non-interactive. Workflow: action:\"start\" with the program as command (returns the screen), then action:\"send\" with text (typed literally) and/or keys (named keys such as Enter, Escape, Tab, Up, C-c, C-d, BSpace) — it waits for the output to settle and returns the screen. action:\"read\" re-reads the screen, \"kill\" closes the session. Remember Enter is a key: to run a line, send text:\"print(1)\" keys:[\"Enter\"].",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start", "send", "read", "kill", "list"], description: "What to do." },
      session: { type: "string", description: "Session name (default \"main\"). Use different names for several programs." },
      command: { type: "string", description: "start: program to run, e.g. \"python3\" or \"vim notes.txt\" (default: an interactive bash)." },
      text: { type: "string", description: "send: literal text to type." },
      keys: { type: "array", items: { type: "string" }, description: "send: named keys to press after the text, e.g. [\"Enter\"] or [\"C-c\"]." },
      scrollback: { type: "integer", description: "Also return this many lines of history above the visible screen." },
      wait_ms: { type: "integer", description: "Max time to wait for output to settle (default 2000, max 30000)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
};
