# Reference

Everything the README leaves out: setup details, tools, permissions, extension points and the layout of the code.

## Setup and providers

```bash
npm install
npm run build && npm link   # puts `revcode` on your PATH
revcode                     # first run walks you through choosing a provider and saving a key
npm run dev                 # or run straight from source (tsx), no build step
```

Or set a key yourself: `cp .env.example .env` and fill in `Z_AI_API_KEY` / `ANTHROPIC_API_KEY` / …, or run `revcode setup` any time (keys are saved to `~/.revcode/.env`, mode 0600, never into a project).

```bash
npm run bundle           # single-file dist/revcode.mjs (what the benchmark adapter ships)
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

## Tools

`read_file`, `write_file`, `edit_file` (fuzzy-tolerant, atomic, with closest-match hints), `apply_patch`, `edit_anchored` (selectable per profile), `delete_file`, `list_directory`, `grep`, `glob`, `shell` (persistent bash; stdin closed; `background: true` for servers; long output spilled to a file), `terminal` (tmux-backed: drive REPLs, vim, debuggers, installers that ask questions — registered when tmux is installed), `view_image` (ask a vision model about a screenshot, diagram or photo — registered when the provider has one: Z.ai `glm-4.6v`, OpenAI/Anthropic main model, others via `REVCODE_VISION_MODEL`), `update_plan`, `task` (read-only research subagent), `use_skill`, and any MCP tools. Read-only calls in one turn run in parallel.

## Safety & permissions

Modes: `ask` (default interactive), `accept-edits`, `plan` (read-only), `yolo` (default for headless runs and inside Universes). Choosing *"don't ask again for `git commit*`"* at a prompt remembers the rule for the project in `.revcode/config.local.json` (kept out of git via `.git/info/exclude`); *"allow all edits this session"* is just accept-edits mode. `--allow "shell(git status*)"` / `--deny "shell(git push*)"` rules; deny always wins. A short list of catastrophic commands (`rm -rf /`, `mkfs`, `dd` to a disk, fork bombs) is refused in **every** mode. Project hooks and MCP servers run commands, so they only load for directories you've trusted.

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
