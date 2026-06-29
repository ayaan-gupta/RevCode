# RevCode

An AI-powered coding agent for the terminal.

RevCode understands your codebase, reads and edits files, runs shell commands, and helps you ship faster — all from your command line.

## Status

Early development. Core agent loop, dual LLM providers, 8 tools, headless mode, and Harbor eval adapters are available.

## Project Structure

```
src/
├── index.ts            # Entry point — CLI bootstrap
├── cli.ts              # Argument parsing
├── agent/
│   └── agent.ts        # Core agent loop (input → LLM → tools → output)
├── llm/
│   ├── client.ts       # LLM API client abstraction (Z.ai + Anthropic)
│   ├── anthropic.ts    # Anthropic Messages API client
│   └── tool-call-parser.ts  # GLM XML / inline JSON fallback parser
├── tools/
│   ├── index.ts        # Tool registry
│   ├── read.ts         # Read files
│   ├── write.ts        # Write files
│   ├── edit.ts         # Targeted file edits
│   ├── shell.ts        # Shell command execution
│   ├── list.ts         # Directory listing
│   ├── grep.ts         # Ripgrep search
│   ├── glob.ts         # File discovery
│   └── delete.ts       # File deletion
├── tui/
│   └── render.ts       # Terminal UI rendering
└── utils/
    └── diff.ts         # Diff utilities

eval/                   # Harbor adapters for Terminal Bench
agent.py                # Python Anthropic prototype
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
| `--model <name>` | Model id (default: `glm-4.6`) |
| `--provider <name>` | `zai`, `anthropic`, or `local-test` |
| `--cwd <path>` | Working directory |
| `--headless` | Run a single task and exit |
| `--prompt <text>` | Task instruction for headless mode |
| `--trajectory-out <path>` | Write JSONL trajectory log |
| `--max-iterations <n>` | Tool loop limit (default: 25) |

## Tools

- `read_file`, `write_file`, `edit_file`, `shell`
- `list_directory`, `grep`, `glob`, `delete_file`

## Headless mode

```bash
npm run build
node dist/index.js --headless --prompt "Summarize README.md" --cwd .
```

## Terminal Bench

See [`eval/README.md`](eval/README.md) for Harbor setup and benchmark commands.

## Scripts

| Command          | Description             |
| ---------------- | ----------------------- |
| `npm run build`  | Compile TypeScript      |
| `npm run dev`    | Run in dev mode (tsx)   |
| `npm run lint`   | Lint source             |
| `npm test`       | Run tests               |

## License

MIT
