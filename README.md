# RevCode

An AI-powered coding agent for the terminal.

RevCode understands your codebase, reads and edits files, runs shell commands, and helps you ship faster — all from your command line.

## Status

🚧 Early development. Not yet functional.

## Project Structure

```
src/
├── index.ts            # Entry point — CLI bootstrap
├── cli.ts              # Argument parsing (--model, --cwd, --headless)
├── agent/
│   └── agent.ts        # Core agent loop (input → LLM → tools → output)
├── llm/
│   └── client.ts       # LLM API client abstraction
├── tools/
│   ├── index.ts        # Tool registry
│   ├── read.ts         # Read files
│   ├── write.ts        # Write files
│   ├── edit.ts         # Targeted file edits
│   └── shell.ts        # Shell command execution
├── tui/
│   └── render.ts       # Terminal UI rendering
└── utils/
    └── diff.ts         # Diff utilities
```

## Getting Started

```bash
npm install
npm run dev
```

## Scripts

| Command          | Description             |
| ---------------- | ----------------------- |
| `npm run build`  | Compile TypeScript      |
| `npm run dev`    | Run in dev mode (tsx)   |
| `npm run lint`   | Lint source             |
| `npm test`       | Run tests               |

## License

MIT
