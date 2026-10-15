/**
 * Copy text to the system clipboard: a native tool when one exists, plus the OSC 52 terminal
 * sequence, which also works over SSH and inside tmux when the terminal allows it.
 */

import { spawn } from "node:child_process";

const OSC52_MAX_BYTES = 100_000;

export function osc52Sequence(text: string): string {
  const data = Buffer.from(text, "utf8").subarray(0, OSC52_MAX_BYTES).toString("base64");
  return `\u001b]52;c;${data}\u0007`;
}

function candidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Array<[string, string[]]> {
  if (platform === "darwin") return [["pbcopy", []]];
  if (platform === "win32") return [["clip", []]];
  const list: Array<[string, string[]]> = [];
  if (env.WAYLAND_DISPLAY) list.push(["wl-copy", []]);
  list.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]], ["clip.exe", []]);
  return list;
}

function tryCommand(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => {
        child.kill();
        done(false);
      }, 2500);
      child.on("error", () => {
        clearTimeout(timer);
        done(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
      child.stdin.on("error", () => done(false));
      child.stdin.end(text);
    } catch {
      done(false);
    }
  });
}

/** Copy `text`; resolves with how it was done ("native" or "osc52" — the caller emits the sequence). */
export async function copyToClipboard(text: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<"native" | "osc52"> {
  for (const [command, args] of candidates(env, platform)) {
    if (await tryCommand(command, args, text)) return "native";
  }
  return "osc52";
}
