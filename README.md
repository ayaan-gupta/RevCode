# RevCode

An AI coding agent for the terminal — with two ideas you won't find in other harnesses:

- **Parallel Universes** — every task can run in an isolated, recorded copy of your project. The agent works with *no permission prompts*; you review one changeset, then **land** it, **rewind** it, **fork** it, **replay** it on another model, or throw it away.
- **Dyno** — a self-tuning harness. `revcode tune` benchmarks edit formats, prompt styles and tool schemas against *your* model on a built-in suite, and keeps what actually helps — with honest statistics.

Plus everything a serious harness needs in 2026: a polished terminal UI, permission modes, sessions, `AGENTS.md`, MCP, skills, hooks, subagents, multi-provider (Z.ai GLM, Claude, OpenAI, OpenRouter, Ollama, any OpenAI-compatible server).

> **Status:** active development. All of the below is covered by automated tests (`npm test`), but **no real-model benchmark numbers are claimed** — see [docs/terminal-bench.md](docs/terminal-bench.md) for what has and hasn't been measured.

Requires Node ≥ 20 and `git`; runs on Linux and macOS (the shell tool needs `bash`). Windows is not supported yet.

## Quick start

```bash
npm install
npm run dev              # interactive session (tsx); first run walks you through choosing a provider and saving a key
```

Or set a key yourself: `cp .env.example .env` and fill in `Z_AI_API_KEY` / `ANTHROPIC_API_KEY` / …, or run `revcode setup` any time (keys are saved to `~/.revcode/.env`, mode 0600, never into a project).

```bash
npm run build && node dist/index.js --help
npm run bundle           # single-file dist/revcode.mjs (what the eval ships)
```

Default model is **`glm-5.2`** via Z.ai. Examples:

```bash
revcode                                   # interactive
revcode --universe                        # interactive, inside a Parallel Universe
revcode run "fix the failing tests"       # one headless task
revcode --provider anthropic --model claude-sonnet-5-5
revcode --provider ollama --model qwen2.5-coder
revcode --provider openai-compat --base-url http://localhost:8000/v1 --model my-model
revcode -c                                # continue the latest session here
```

Behind an HTTP(S) proxy, set `HTTPS_PROXY` (and `NO_PROXY`) as usual — RevCode re-launches itself once with Node's `NODE_USE_ENV_PROXY=1` (Node 22.21+/24+) so model calls go through it. Set `REVCODE_NO_PROXY_REEXEC=1` to opt out.

## The terminal UI

An inline, scrollback-friendly interface: your conversation lives in the terminal's own scrollback (select, search and copy as usual) while a small live block stays pinned at the bottom with the activity line, the prompt, completions and the status line. It keeps working *while the agent works* — type ahead and your messages queue, press **Esc** to interrupt, answer permission prompts in the same place.

- **Real prompt editing.** Multi-line input (**Shift+Enter**, **Ctrl+J**, or `\` then Enter), word/line motions, kill ring (**Ctrl+W/U/K/Y**), undo (**Ctrl+_**), per-project history (**↑/↓**, **Ctrl+R** search), Unicode/emoji-aware cursor movement, and bracketed paste — large pastes collapse to `[Pasted text #1 +42 lines]` and are sent in full. Drop a file onto the terminal and it becomes an `@mention`.
- **Completion.** `/` shows commands (and their arguments — models, modes, sessions); `@` fuzzy-completes files from your project (git-aware); **Tab** accepts.
- **Readable output.** Markdown with tables, lists, quotes, task lists, links and syntax-highlighted code; long paragraphs stream row by row. Tool calls render as compact cards (command + exit code + output preview, file diffs with line numbers and shading); **Ctrl+O** shows more. Terminal escape sequences in tool output are stripped.
- **Permission prompts with context.** Edits show a diff *before* you approve; shell commands show the command. Choose *yes*, *yes and don't ask again for `git commit*`* (or *allow all edits this session*), or *no — and tell RevCode what to do instead*. **Shift+Tab** cycles ask → accept-edits → plan; in plan mode a finished plan offers to carry itself out.
- **Works everywhere.** Truecolor → 256 → 16 colors → none (`NO_COLOR`), light/dark themes (`--theme`, `/theme`), ASCII fallback on the Linux console, OSC 8 hyperlinks where supported, plain line mode for pipes and `TERM=dumb`. Resizing, suspend (**Ctrl+Z**) and focus changes are handled; the terminal is always restored on exit.
- **Quality of life.** `!cmd` runs a shell command yourself (and tells the model); `-p "task"` runs headlessly; friendly explanations for auth/rate-limit/network errors; the status line shows mode, project, git branch, model and context use; the terminal title shows when it is working.

| Key | Action |
| --- | --- |
| Enter | send · Shift+Enter / Ctrl+J / `\` Enter: new line |
| Esc | interrupt a running task · clear the prompt (undoable) |
| Ctrl+C | clear the prompt · twice to quit (twice during a task: quit now) |
| ↑ ↓ · Ctrl+R | history · reverse search |
| Tab · Shift+Tab | accept completion · cycle permission mode |
| Ctrl+O · Ctrl+L · Ctrl+Z | more tool output · clear screen · suspend |
| Alt+B/F · Ctrl+A/E · Ctrl+W/U/K/Y · Ctrl+_ | word/line motion · delete/yank · undo |

Slash commands: `/help` `/status` `/model` `/mode` `/plan` `/clear` `/compact` `/context` `/cost` `/resume` `/sessions` `/init` `/review` `/copy` `/export` `/verbose` `/theme` `/permissions` `/mcp` `/skills` `/hooks` `/memory` `/tools` `/profile` `/doctor` `/receipt` `/exit` — plus the Parallel Universe commands below and any custom commands or skills. Shell completion: `revcode completion bash|zsh|fish`.

Shift+Enter needs a terminal that reports modified keys (kitty keyboard protocol): iTerm2, Ghostty, WezTerm, kitty, foot, Windows Terminal, recent VS Code. Elsewhere use **Ctrl+J** or `\` + Enter. More in [docs/tui.md](docs/tui.md) (terminal notes, environment switches, how it is built and tested).

## Parallel Universes

```bash
revcode --universe          # or: "universe": true in .revcode/config.json
```

The agent gets a private copy of your project (tracked + untracked files; dependency dirs like `node_modules` are symlinked for speed). Every mutating tool call is checkpointed into a shadow git repo, so the whole run is a timeline you can navigate:

| In a session | From the shell | What it does |
| --- | --- | --- |
| `/diff [full]` | `revcode universes diff <id>` | changeset vs. your project |
| `/land [paths] [--markers\|--theirs]` | `revcode universes land <id>` | apply it, with a **3-way merge** if you edited the project meanwhile; real conflicts are never overwritten |
| `/checkpoints`, `/rewind <n>` | `revcode universes show <id>` | jump files **and conversation** back to any step (undoable) |
| `/fork [n]` | `revcode universes fork <id> [n]` | branch a sibling universe |
| — | `revcode universes replay <id> --model X` | re-run the same prompts from the same starting point on another model |
| — | `revcode universes compare <a> <b> --verify "pytest -q"` | side-by-side effort, file differences, and a real pass/fail |
| — | `revcode universes share <id>` | self-contained HTML replay of the run |
| `/discard` | `revcode universes discard <id>` | throw it away |

Every turn ends with a **receipt**: commands run with exit codes, files actually changed, whether anything was verified *after* the last change, and warnings such as "modified an existing test file".

Details, guarantees and limits: [docs/universes.md](docs/universes.md).

## Dyno

```bash
revcode tune --model glm-5.2 --dry-run     # see the plan, spend nothing
revcode tune --model glm-5.2 --budget 150  # run it; saves ~/.revcode/profiles/zai__glm-5.2.json
revcode profile show                       # what's active, and the evidence
```

Harness choices (edit tool format, prompt style, tool-schema style, parallel tool calls, verification gates, temperature) can move a benchmark score by 10+ points on the *same* model. Dyno turns those into a search: baseline → one change at a time on the tasks that failed → **confirm against a fresh baseline** (so a lucky re-run can't masquerade as a gain). If nothing reliably helps it says so and keeps the defaults. Tuned profiles load automatically for that model. Details: [docs/dyno.md](docs/dyno.md).

## Safety & permissions

Modes: `ask` (default interactive), `accept-edits`, `plan` (read-only), `yolo` (default for headless runs and inside Universes). `--allow "shell(git status*)"` / `--deny "shell(git push*)"` rules; deny always wins. A short list of catastrophic commands (`rm -rf /`, `mkfs`, `dd` to a disk, fork bombs) is refused in **every** mode. Project hooks and MCP servers run commands, so they only load for directories you've trusted.

## Tools

`read_file`, `write_file`, `edit_file` (fuzzy-tolerant, atomic, with closest-match hints), `apply_patch`, `edit_anchored` (selectable per profile), `delete_file`, `list_directory`, `grep`, `glob`, `shell` (persistent bash; stdin closed; `background: true` for servers; long output spilled to a file), `terminal` (tmux-backed: drive REPLs, vim, debuggers, installers that ask questions — registered when tmux is installed), `view_image` (ask a vision model about a screenshot, diagram or photo — registered when the provider has one: Z.ai `glm-4.6v`, OpenAI/Anthropic main model, others via `REVCODE_VISION_MODEL`), `update_plan`, `task` (read-only research subagent), `use_skill`, and any MCP tools. Read-only calls in one turn run in parallel.

## Extending

- **Project instructions:** `AGENTS.md` (or `CLAUDE.md`) from the git root down to the working directory, plus `~/.revcode/AGENTS.md`.
- **Config:** `~/.revcode/config.json`, `.revcode/config.json`, `.revcode/config.local.json` (CLI flags win).
- **MCP:** `.mcp.json` / `.revcode/mcp.json` (stdio, Streamable HTTP, legacy SSE).
- **Skills:** `SKILL.md` in `.revcode/skills`, `.claude/skills`, `.agents/skills`.
- **Slash commands:** markdown in `.revcode/commands/`.
- **Hooks:** `.revcode/hooks.json` — `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`.

## Project structure

```
src/
├── agent/      engine (loop), runtime assembly, permissions, sessions, summarization, subagents
├── harness/    profile (Dyno's knobs), prompt builder, gates, time budget, env snapshot
├── llm/        providers (OpenAI-compatible, Anthropic), SSE, retry
├── tools/      file tools, shell session, edit modes, apply-patch, anchored edits
├── universe/   Parallel Universes: snapshots, land/merge, receipts, replay, compare, export
├── dyno/       task suite, runner, tuner, report
├── tui/        live prompt region, line editor, key parser, markdown/diff/tool rendering, themes
├── mcp/ skills/ hooks/ config/ commands/
eval/           Harbor adapter for Terminal-Bench
docs/           universes, dyno, terminal-bench, memory design
```

## Scripts

`npm run build` · `npm run bundle` · `npm run dev` · `npm run lint` · `npm test`

## Attribution

Some techniques and code are adapted from open-source harnesses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT
