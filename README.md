# RevCode

An AI coding agent for the terminal — with two ideas you won't find in other harnesses:

- **Parallel Universes** — every task can run in an isolated, recorded copy of your project. The agent works with *no permission prompts*; you review one changeset, then **land** it, **rewind** it, **fork** it, **replay** it on another model, or throw it away.
- **Dyno** — a self-tuning harness. `revcode tune` benchmarks edit formats, prompt styles and tool schemas against *your* model on a built-in suite, and keeps what actually helps — with honest statistics.

Plus everything a serious harness needs in 2026: streaming TUI, permission modes, sessions, `AGENTS.md`, MCP, skills, hooks, subagents, multi-provider (Z.ai GLM, Claude, OpenAI, OpenRouter, Ollama, any OpenAI-compatible server).

> **Status:** active development. All of the below is covered by automated tests (`npm test`), but **no real-model benchmark numbers are claimed** — see [docs/terminal-bench.md](docs/terminal-bench.md) for what has and hasn't been measured.

Requires Node ≥ 20 and `git`; runs on Linux and macOS (the shell tool needs `bash`). Windows is not supported yet.

## Quick start

```bash
cp .env.example .env     # add a key, e.g. Z_AI_API_KEY or ANTHROPIC_API_KEY
npm install
npm run dev              # interactive session (tsx)
```

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

`read_file`, `write_file`, `edit_file` (fuzzy-tolerant, atomic, with closest-match hints), `apply_patch`, `edit_anchored` (selectable per profile), `delete_file`, `list_directory`, `grep`, `glob`, `shell` (persistent bash; stdin closed; `background: true` for servers; long output spilled to a file), `terminal` (tmux-backed: drive REPLs, vim, debuggers, installers that ask questions — registered when tmux is installed), `update_plan`, `task` (read-only research subagent), `use_skill`, and any MCP tools. Read-only calls in one turn run in parallel.

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
├── mcp/ skills/ hooks/ config/ commands/ tui/
eval/           Harbor adapter for Terminal-Bench
docs/           universes, dyno, terminal-bench, memory design
```

## Scripts

`npm run build` · `npm run bundle` · `npm run dev` · `npm run lint` · `npm test`

## Attribution

Some techniques and code are adapted from open-source harnesses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT
