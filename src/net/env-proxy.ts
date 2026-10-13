/**
 * Make Node's built-in `fetch` honor `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`.
 *
 * Node ignores those variables unless `NODE_USE_ENV_PROXY=1` is set at process
 * start (22.21+/24+), so behind a corporate or sandbox proxy every model call
 * fails with `fetch failed`. The flag cannot be flipped after startup, so the
 * entry point re-launches itself once with it set. Proxy-less environments
 * (including benchmark containers) never take this path.
 */

import { spawn } from "node:child_process";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

/** `NODE_USE_ENV_PROXY` landed in Node 24.0 and was backported to 22.21. */
export function nodeSupportsEnvProxy(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return major >= 24 || (major === 22 && minor >= 21);
}

export function shouldReexecForProxy(env: NodeJS.ProcessEnv, nodeVersion: string): boolean {
  if (env.REVCODE_NO_PROXY_REEXEC || env.NODE_USE_ENV_PROXY) {
    return false;
  }
  return PROXY_VARS.some((name) => Boolean(env[name])) && nodeSupportsEnvProxy(nodeVersion);
}

/**
 * Re-launches the current command with proxy support on. Resolves to the
 * child's exit code, or `undefined` when no re-launch is needed (or possible)
 * and the caller should carry on in this process.
 */
export function reexecWithEnvProxy(): Promise<number | undefined> {
  if (!shouldReexecForProxy(process.env, process.versions.node)) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, "--disable-warning=UNDICI-EHPA", ...process.argv.slice(1)],
      { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } },
    );

    // Ctrl-C reaches the whole foreground process group, so on a terminal the
    // child already has it; forwarding would deliver it twice.
    const forwarded: NodeJS.Signals[] = process.stdout.isTTY ? ["SIGTERM", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of forwarded) {
      process.on(signal, forward);
    }
    if (process.stdout.isTTY) {
      process.on("SIGINT", () => {});
    }

    child.on("error", () => resolve(undefined)); // could not spawn: run in-process
    child.on("exit", (code, signal) => {
      resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 1));
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return (
    { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as Partial<Record<NodeJS.Signals, number>>
  )[signal];
}
