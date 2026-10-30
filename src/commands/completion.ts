/** `revcode completion <bash|zsh|fish>`: shell completion scripts generated from the real flag table. */

import { flagNames, raceFlagNames } from "../cli.js";
import { PERMISSION_MODES } from "../agent/permissions.js";
import { LLM_PROVIDERS } from "../llm/client.js";

const SUBCOMMANDS = ["run", "race", "tune", "universes", "sessions", "profile", "setup", "completion", "help", "version"];
const FILE_FLAGS = ["--cwd", "--prompt-file", "--trajectory-out", "--profile"];

function valuesFor(flag: string): string[] | undefined {
  switch (flag) {
    case "--provider":
      return [...LLM_PROVIDERS];
    case "--mode":
      return [...PERMISSION_MODES];
    case "--output-format":
      return ["text", "json", "stream-json"];
    case "--theme":
      return ["auto", "dark", "light"];
    default:
      return undefined;
  }
}

export function completionScript(shell: string): string | undefined {
  const base = flagNames();
  // Race flags are offered everywhere: completion scripts don't track the subcommand.
  const raceOnly = raceFlagNames().filter((flag) => !base.long.includes(flag));
  const long = [...base.long, ...raceOnly];
  const valued = [...base.valued, ...raceOnly.filter((flag) => flag !== "--yes")];
  const short = base.short;
  const flags = [...long, ...short];
  if (shell === "bash") {
    const cases = ["--provider", "--mode", "--output-format", "--theme"]
      .map((flag) => `    ${flag}) COMPREPLY=($(compgen -W "${(valuesFor(flag) ?? []).join(" ")}" -- "$cur")); return;;`)
      .join("\n");
    return `# bash completion for revcode
_revcode() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
${cases}
    ${FILE_FLAGS.join("|")}) COMPREPLY=($(compgen -f -- "$cur")); return;;
  esac
  if [[ $COMP_CWORD -eq 1 && "$cur" != -* ]]; then
    COMPREPLY=($(compgen -W "${SUBCOMMANDS.join(" ")}" -- "$cur")); return
  fi
  COMPREPLY=($(compgen -W "${flags.join(" ")}" -- "$cur"))
}
complete -o default -F _revcode revcode
`;
  }
  if (shell === "zsh") {
    const specs = long.map((flag) => {
      const values = valuesFor(flag);
      if (values) return `    '${flag}[${flag.slice(2)}]:value:(${values.join(" ")})'`;
      if (FILE_FLAGS.includes(flag)) return `    '${flag}[${flag.slice(2)}]:file:_files'`;
      return valued.includes(flag) ? `    '${flag}[${flag.slice(2)}]:value:'` : `    '${flag}[${flag.slice(2)}]'`;
    });
    return `#compdef revcode
# zsh completion for revcode
_revcode() {
  local -a subcommands
  subcommands=(${SUBCOMMANDS.map((c) => `'${c}'`).join(" ")})
  if (( CURRENT == 2 )) && [[ "$words[2]" != -* ]]; then
    _describe 'command' subcommands
    return
  fi
  _arguments \\
${specs.join(" \\\n")}
}
compdef _revcode revcode
`;
  }
  if (shell === "fish") {
    const lines = [`# fish completion for revcode`, `complete -c revcode -f -n '__fish_use_subcommand' -a '${SUBCOMMANDS.join(" ")}'`];
    for (const flag of long) {
      const values = valuesFor(flag);
      const file = FILE_FLAGS.includes(flag) ? " -r -F" : values ? ` -x -a '${values.join(" ")}'` : "";
      lines.push(`complete -c revcode -l ${flag.slice(2)}${file}`);
    }
    return `${lines.join("\n")}\n`;
  }
  return undefined;
}
