/**
 * Conservative shell-command classification for the permission layer.
 *
 * We never try to PROVE a command is harmless — only to recognize a small set of
 * plainly read-only invocations (so `ls`, `git status`, `rg foo` don't nag the
 * user) and a small set of catastrophic ones (refused in every mode). Anything
 * ambiguous is "unknown" and goes through the normal approval flow.
 */

export type ShellClass = "safe" | "unknown" | "catastrophic";

const SAFE_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "which", "whoami", "id", "uname",
  "date", "stat", "file", "du", "df", "tree", "basename", "dirname", "realpath", "readlink",
  "grep", "egrep", "fgrep", "rg", "sort", "uniq", "diff", "cmp", "cut", "tr", "nl", "tac", "rev",
  "true", "false", "test", "[", "cd", "type", "command", "hostname", "nproc", "free", "ps",
  "jq", "md5sum", "sha1sum", "sha256sum", "column", "less", "more", "sleep", "seq", "xxd", "od",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog",
  "remote", "config", "ls-tree", "cat-file", "grep", "tag", "branch", "stash",
]);

const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-[a-zA-Z-]+\s+)*(?:--no-preserve-root\s+)?(?:\/|~|\$HOME|\/\*|~\/\*)(?:\s|$)/,
  /\brm\s+(?:-[a-zA-Z]*\s+)*--recursive\s+(?:-[a-zA-Z-]+\s+)*(?:\/|~|\$HOME)(?:\s|$)/,
  /\bmkfs(?:\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|vd|hd|xvd|mmcblk)/,
  />\s*\/dev\/(?:sd|nvme|vd|hd|xvd|mmcblk)/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bchmod\s+-R\s+0?777\s+\/(?:\s|$)/,
  /\bchown\s+-R\s+\S+\s+\/(?:\s|$)/,
];

export function classifyShellCommand(command: string): ShellClass {
  if (CATASTROPHIC_PATTERNS.some((pattern) => pattern.test(command))) {
    return "catastrophic";
  }

  const parsed = splitCommand(command);
  if (!parsed || parsed.segments.length === 0) {
    return "unknown";
  }
  return parsed.segments.every(isSafeSegment) ? "safe" : "unknown";
}

interface ParsedCommand {
  segments: string[][];
}

/**
 * Split on unquoted control operators into word lists. Returns undefined when
 * the command uses constructs we refuse to reason about (substitution,
 * redirection to files, heredocs, unbalanced quotes).
 */
export function splitCommand(command: string): ParsedCommand | undefined {
  const segments: string[][] = [];
  let words: string[] = [];
  let current = "";
  let hasWord = false;
  let quote: "'" | '"' | undefined;

  const endWord = (): void => {
    if (hasWord) {
      words.push(current);
    }
    current = "";
    hasWord = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) {
      segments.push(words);
    }
    words = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
      } else if (ch === "\\" && next !== undefined) {
        current += next;
        i += 1;
      } else if (ch === "`" || (ch === "$" && next === "(")) {
        return undefined;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      current += next;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(") || (ch === "<" && next === "(") || (ch === ">" && next === "(")) {
      return undefined;
    }
    if (ch === ">" || ch === "<") {
      // Allow only harmless fd redirections: 2>&1, >/dev/null, 2>/dev/null, </dev/null
      const rest = command.slice(i);
      const allowed = /^(?:>>?|<)\s*\/dev\/null\b/.exec(rest) ?? /^>&\d\b/.exec(rest);
      if (!allowed) {
        return undefined;
      }
      // Drop a trailing fd digit that was captured as part of the previous word ("2>").
      if (/^\d$/.test(current)) {
        current = "";
        hasWord = false;
      }
      i += allowed[0].length - 1;
      continue;
    }
    if (ch === "&" && next === "&") {
      endSegment();
      i += 1;
      continue;
    }
    if (ch === "|" && next === "|") {
      endSegment();
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
      endSegment();
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    current += ch;
    hasWord = true;
  }

  if (quote) {
    return undefined;
  }
  endSegment();
  return { segments };
}

function isSafeSegment(words: string[]): boolean {
  // Skip leading VAR=value assignments.
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
    index += 1;
  }
  const [cmd, ...args] = words.slice(index);
  if (!cmd) {
    return true;
  }

  if (args.length === 1 && ["--version", "-V", "--help", "-h", "version"].includes(args[0])) {
    return true;
  }

  switch (cmd) {
    case "git": {
      const sub = args.find((arg) => !arg.startsWith("-"));
      if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) return false;
      const rest = args.slice(args.indexOf(sub) + 1);
      if (sub === "branch" || sub === "tag") return rest.every((a) => a.startsWith("-") && !/^-[dDmMcCfF]|--(delete|move|copy|force)/.test(a));
      if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
      if (sub === "remote") return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url";
      if (sub === "config") return rest.some((a) => a === "--get" || a === "--list" || a === "-l");
      return true;
    }
    case "find":
      return !args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fls"].includes(arg));
    case "sed":
      return !args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === "--in-place");
    case "sort":
      return !args.some((arg) => arg === "-o" || arg.startsWith("--output"));
    case "ps":
    case "free":
      return true;
    default:
      return SAFE_COMMANDS.has(cmd);
  }
}

/** First word + subcommand, used to build an "always allow" rule like `git commit*`. */
export function commandPrefix(command: string): string {
  const parsed = splitCommand(command);
  const first = parsed?.segments[0] ?? command.trim().split(/\s+/);
  let index = 0;
  while (index < first.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first[index])) {
    index += 1;
  }
  const [cmd, sub] = first.slice(index);
  if (!cmd) return command.trim();
  if (sub && !sub.startsWith("-") && ["git", "npm", "pnpm", "yarn", "cargo", "go", "docker", "kubectl", "pip", "pip3", "make"].includes(cmd)) {
    return `${cmd} ${sub}`;
  }
  return cmd;
}
