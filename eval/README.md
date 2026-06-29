# Terminal Bench Evaluation

This directory contains Harbor adapters for running RevCode against [Terminal Bench](https://www.tbench.ai) via the [Harbor](https://www.harborframework.com) harness.

## Prerequisites

- Docker running locally
- Python 3.12+
- Node.js 20+ (for local RevCode development)
- API keys in `.env` at the repo root:
  - `Z_AI_API_KEY` for RevCode (Z.ai / GLM)
  - `ANTHROPIC_API_KEY` for `agent.py`

## Install Harbor tooling

```bash
python3 -m pip install -r eval/requirements.txt
```

## Sanity check (oracle solutions)

```bash
harbor run -d terminal-bench/terminal-bench-2 -a oracle
```

## Fast inner loop (manual stress tests)

See [`NOTES.md`](../NOTES.md) for the `/tmp/agent_bench` fixture and 5 efficiency tasks.

```bash
# TypeScript RevCode
npm install
npm run dev

# Python prototype
python3 -m pip install -r requirements.txt
python3 agent.py
```

## Headless single-task mode

```bash
# TypeScript
npm run build
node dist/index.js --headless --prompt "List files in src/" --cwd .

# Python
python3 agent.py --headless --prompt "List files in src/" --cwd .
```

Both support `--trajectory-out /tmp/trajectory.jsonl` for Harbor trajectory parsing.

## Run Terminal Bench with RevCode

```bash
harbor run -d "terminal-bench/terminal-bench-2" \
  --agent-import-path eval.revcode_agent:RevCodeAgent \
  --n-concurrent 1
```

## Run Terminal Bench with agent.py

```bash
harbor run -d "terminal-bench/terminal-bench-2" \
  --agent-import-path eval.agent_py_agent:AgentPyAgent \
  --n-concurrent 1
```

## Providers

RevCode supports both providers:

```bash
npm run dev -- --provider zai --model glm-4.6
npm run dev -- --provider anthropic --model claude-sonnet-4-20250514
npm run dev -- --provider local-test
```

Local test mode accepts `/tool <name> <json>` commands for tool testing without API keys.
