/**
 * Inside a universe the agent works without asking, because its file changes
 * stay in a private copy. Some commands reach past the copy anyway: pushing,
 * publishing, deploying, sudo, other machines, installing software, or writing
 * to the real project or elsewhere on disk. This spots those (a deliberately
 * simple, conservative check) so the permission layer can still ask first.
 *
 * Returns a short reason ("pushes to a git remote"), or undefined when the
 * command plainly stays inside the copy.
 */

import os from "node:os";
import path from "node:path";

export interface OutsideContext {
  /** The user's real project directory. */
  projectRoot: string;
  /** The universe's working copy (where the agent runs). */
  copyDir: string;
  home?: string;
}

interface Rule {
  pattern: RegExp;
  reason: string;
}

// `(?:^|[;&|(\s])` keeps "git push" from matching inside words like "digit push".
const START = String.raw`(?:^|[;&|(\s])`;

const RULES: Rule[] = [
  { pattern: new RegExp(`${START}git\\s+(?:(?:-[Cc]\\s+\\S+|-\\S+)\\s+)*push\\b`), reason: "pushes to a git remote" },
  {
    pattern: new RegExp(
      `${START}gh\\s+(?:pr\\s+(?:create|merge|close|comment|edit|review|reopen|ready)|issue\\s+(?:create|close|comment|edit|reopen|delete|transfer)|release\\s+(?:create|delete|edit|upload)|repo\\s+(?:create|delete|edit|rename|archive|fork|sync)|secret\\s+set|variable\\s+set|workflow\\s+(?:run|enable|disable)|run\\s+(?:rerun|cancel))\\b`,
    ),
    reason: "changes something on GitHub",
  },
  { pattern: new RegExp(`${START}gh\\s+api\\b[^;&|]*(?:\\s(?:-X|--method)\\s*(?:POST|PUT|PATCH|DELETE)|\\s(?:-f|-F|--field|--raw-field|--input)\\b)`, "i"), reason: "changes something on GitHub" },
  {
    pattern: new RegExp(
      `${START}(?:(?:npm|pnpm|yarn|bun)\\s+publish|cargo\\s+publish|twine\\s+upload|poetry\\s+publish|gem\\s+push|dotnet\\s+nuget\\s+push|vsce\\s+publish|ovsx\\s+publish|mvn\\b[^;&|]*\\sdeploy)\\b`,
    ),
    reason: "publishes a package",
  },
  { pattern: new RegExp(`${START}docker\\s+(?:push|login)\\b`), reason: "pushes a container image" },
  {
    pattern: new RegExp(
      `${START}(?:kubectl\\s+(?:apply|create|delete|replace|patch|scale|rollout|set|edit|drain|cordon)|helm\\s+(?:install|upgrade|uninstall|rollback)|terraform\\s+(?:apply|destroy|import)|tofu\\s+(?:apply|destroy)|pulumi\\s+(?:up|destroy)|fly(?:ctl)?\\s+deploy|vercel\\b[^;&|]*(?:--prod|\\sdeploy)|netlify\\s+deploy|firebase\\s+deploy|heroku\\s|serverless\\s+deploy|sls\\s+deploy|wrangler\\s+(?:deploy|publish)|aws\\s+\\S+\\s+(?:delete|put|create|terminate|update|rm|cp|sync|mv)\\b|gcloud\\b[^;&|]*\\s(?:deploy|delete|create)\\b)`,
    ),
    reason: "deploys or changes cloud resources",
  },
  { pattern: new RegExp(`${START}(?:sudo|doas)\\s`), reason: "runs as an administrator" },
  { pattern: new RegExp(`${START}su(?:\\s+-)?\\s*(?:$|[;&|])`), reason: "runs as an administrator" },
  { pattern: new RegExp(`${START}(?:ssh|scp|sftp|mosh)\\s`), reason: "connects to another machine" },
  { pattern: new RegExp(`${START}rsync\\b[^;&|]*\\s[\\w.-]+@?[\\w.-]*:`), reason: "connects to another machine" },
  {
    pattern: new RegExp(
      `${START}(?:(?:npm|pnpm|bun)\\s+(?:i|install|add|uninstall|remove|rm|update|link)\\b[^;&|]*\\s(?:-g|--global)\\b|yarn\\s+global\\s|(?:brew|apt|apt-get|dnf|yum|pacman|zypper|apk|snap|port)\\s+(?:install|remove|uninstall|upgrade|purge|add|del|reinstall)\\b|pipx?\\s+install\\b[^;&|]*--user\\b|gem\\s+install\\b|cargo\\s+install\\b|go\\s+install\\b)`,
    ),
    reason: "installs software on your machine",
  },
  { pattern: new RegExp(`${START}crontab\\s+(?!-l\\b)`), reason: "changes scheduled jobs on your machine" },
  { pattern: new RegExp(`${START}(?:systemctl|launchctl|service)\\s+(?:start|stop|restart|enable|disable|load|unload|bootstrap|bootout)\\b`), reason: "changes services on your machine" },
  { pattern: new RegExp(`${START}(?:pkill|killall)\\s`), reason: "stops programs by name" },
];

/** Commands whose path arguments are written, moved or deleted. */
const WRITING_COMMANDS = new Set(["rm", "rmdir", "mv", "cp", "chmod", "chown", "chgrp", "ln", "touch", "mkdir", "tee", "truncate", "install", "unlink", "shred", "dd"]);

export function reachesOutside(command: string, ctx: OutsideContext): string | undefined {
  const text = command.split(ctx.copyDir).join(".");
  if (mentionsPath(text, ctx.projectRoot)) {
    return "uses your real project folder instead of the copy";
  }
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.reason;
  }
  const outside = writtenPaths(text).find((p) => isOutside(p, ctx));
  if (outside) return `changes files outside the project (${outside})`;
  return undefined;
}

/** Path targets of redirections and of file-writing commands (best effort; quotes stripped). */
export function writtenPaths(command: string): string[] {
  const paths: string[] = [];
  for (const match of command.matchAll(/(?:^|[^<>&\d])\d?>>?\|?\s*("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
    paths.push(unquote(match[1]));
  }
  for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
    const words = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g)?.map(unquote) ?? [];
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1; // FOO=bar cmd
    if (words[i] === "command" || words[i] === "exec" || words[i] === "nohup") i += 1;
    const name = path.basename(words[i] ?? "");
    if (!WRITING_COMMANDS.has(name)) continue;
    const args = words.slice(i + 1).filter((word) => !word.startsWith("-"));
    if (name === "dd") {
      paths.push(...args.filter((word) => word.startsWith("of=")).map((word) => word.slice(3)));
    } else if (name === "cp" || name === "ln" || name === "install") {
      // Only the destination is written; sources are read.
      if (args.length >= 2) paths.push(args[args.length - 1]);
    } else {
      paths.push(...args);
    }
  }
  return paths;
}

function isOutside(target: string, ctx: OutsideContext): boolean {
  const home = ctx.home ?? os.homedir();
  let resolved: string;
  if (target === "~" || target.startsWith("~/")) resolved = path.join(home, target.slice(1));
  else if (target === "$HOME" || target.startsWith("$HOME/") || target.startsWith("${HOME}")) resolved = path.join(home, target.replace(/^\$\{?HOME\}?/, ""));
  else if (path.isAbsolute(target)) resolved = path.normalize(target);
  else return false; // relative: inside the copy
  const allowed = [ctx.copyDir, "/tmp", "/var/tmp", "/private/tmp", "/private/var/folders", "/var/folders", "/dev", os.tmpdir()];
  return !allowed.some((dir) => resolved === dir || resolved.startsWith(dir.endsWith("/") ? dir : `${dir}/`));
}

function mentionsPath(text: string, dir: string): boolean {
  if (!dir || dir === "/") return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(dir, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + dir.length] ?? "";
    if (!/[\w.-]/.test(before) && (after === "" || /[/\s"'`;&|)]/.test(after))) return true;
    from = at + 1;
  }
}

function unquote(word: string): string {
  return word.length >= 2 && (word[0] === '"' || word[0] === "'") && word.at(-1) === word[0] ? word.slice(1, -1) : word;
}
