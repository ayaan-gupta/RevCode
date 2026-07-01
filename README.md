# RevCode

An AI-powered coding agent for the terminal.

RevCode understands your codebase, reads and edits files, runs shell commands, and helps you ship faster — all from your command line.

## Status

Active development. Highlights:

- **Persistent, stateful shell** — `cd`, environment, virtualenvs, and background servers persist across `shell` calls (run servers with `background: true`).
- **Resilient LLM layer** — automatic retry/backoff on transient API errors, plus live streaming.
- **Agentic loop** — a structured, environment-aware system prompt, a planning tool, position-aware parallel tool execution, and rule-based context compaction for long tasks.
- **Polished TUI** — streaming Markdown output, colored diffs, tool-call cards, a plan panel, and a context-usage gauge.
- **Fast evals** — a single-file bundle lets Harbor trials skip `npm install`/build.

Default model: **`glm-5.2`** (Z.ai). Anthropic Claude is supported as a secondary provider.

## Project Structure

```
src/
├── index.ts            # Entry point — CLI bootstrap
├── cli.ts              # Argument parsing
├── agent/
│   ├── agent.ts        # Core agent loop (input → LLM → tools → output)
│   └── context.ts      # Token estimation + rule-based context compaction
├── llm/
│   ├── client.ts       # LLM API client abstraction (Z.ai + Anthropic) + streaming
│   ├── anthropic.ts    # Anthropic Messages API client
│   ├── retry.ts        # Resilient fetch (retry/backoff on 429/5xx/network)
│   └── tool-call-parser.ts  # GLM XML / inline JSON fallback parser
├── tools/
│   ├── index.ts        # Tool registry
│   ├── shell.ts        # Shell tool (delegates to the persistent session)
│   ├── shell-session.ts # Persistent, stateful bash session
│   ├── plan.ts         # update_plan checklist tool
│   ├── read.ts / write.ts / edit.ts / delete.ts
│   └── list.ts / grep.ts / glob.ts
├── tui/
│   ├── render.ts       # Terminal UI rendering
│   ├── markdown.ts     # Streaming Markdown → ANSI renderer
│   ├── format.ts       # Tool-call cards + colored diffs
│   ├── input.ts        # Raw-mode line editor
│   └── banner.ts / spinner.ts / ansi.ts / theme.ts
└── utils/
    └── diff.ts         # Diff utilities

eval/                   # Harbor adapters for Terminal Bench
scripts/bundle.mjs      # esbuild single-file bundler (for fast eval cold-start)
```

## Getting Started

```bash
cp .env.example .env
# Add Z_AI_API_KEY and/or ANTHROPIC_API_KEY

npm install
npm run dev
```

## CLI Options

| Flag | Description |
| ---- | ----------- |
| `--model <name>` | Model id (default: `glm-5.2`; suggested: `glm-5.2`, `glm-4.7`, `glm-4.7-flash`) |
| `--provider <name>` | `zai`, `anthropic`, or `local-test` |
| `--cwd <path>` | Working directory |
| `--headless` | Run a single task and exit |
| `--prompt <text>` | Task instruction for headless mode |
| `--trajectory-out <path>` | Write JSONL trajectory log |
| `--max-iterations <n>` | Tool loop limit (default: 50) |

## Tools

- `read_file`, `write_file`, `edit_file`, `delete_file`
- `shell` — persistent session; `background: true` for long-running processes
- `list_directory`, `grep`, `glob`
- `update_plan` — maintain an ordered checklist for multi-step tasks

Read-only tools (`read_file`, `grep`, `glob`, `list_directory`) issued together in one turn run concurrently; mutating tools run sequentially.

### Interactive commands

`/help`, `/model`, `/tools`, `/memory`, `/tokens` (context usage), `/compact` (reclaim context), `/clear`, `/exit`.

## Headless mode

```bash
npm run build
node dist/index.js --headless --prompt "Summarize README.md" --cwd .
```

## Terminal Bench

See [`eval/README.md`](eval/README.md) for Harbor setup and benchmark commands.

## Scripts

| Command          | Description                              |
| ---------------- | ---------------------------------------- |
| `npm run build`  | Compile TypeScript                       |
| `npm run bundle` | Bundle to a single `dist/revcode.mjs`    |
| `npm run dev`    | Run in dev mode (tsx)                    |
| `npm run lint`   | Lint source                              |
| `npm test`       | Run tests                                |

## Known limitations

- **Background processes intentionally survive agent exit.** Anything you start
  with `background: true` (or an inline `&`/`nohup`) is meant to keep running
  ("start the server and keep it running"), so on shutdown RevCode lets bash
  exit cleanly rather than killing its process group. Under Harbor/eval the
  container teardown reaps these; for long-lived interactive use outside a
  disposable container, stop them yourself (the tool reports each background
  pid and log file).
- `shell` merges stdout and stderr into a single ordered stream.

## License

MIT
