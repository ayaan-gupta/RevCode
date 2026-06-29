# Terminal Bench Evaluation

This directory contains Harbor adapters for running RevCode against [Terminal Bench](https://www.tbench.ai) via the [Harbor](https://www.harborframework.com) harness.

## Prerequisites

- Docker running locally
- Python 3.12+ (for Harbor CLI only)
- Node.js 20+
- `Z_AI_API_KEY` in `.env` at the repo root (for RevCode / Z.ai GLM)

Run `harbor` from the **repo root** so `eval.*` is importable (or set `PYTHONPATH` to the repo root):

```bash
export PYTHONPATH="$(pwd)"
```

## Sanity check (oracle solutions)

```bash
harbor run -d terminal-bench/terminal-bench-2 -a oracle
```

## Fast inner loop (manual stress tests)

See [`NOTES.md`](../NOTES.md) for the `/tmp/agent_bench` fixture and 5 efficiency tasks.

```bash
npm install
npm run dev
```

## Headless single-task mode

```bash
npm run build
node dist/index.js --headless --prompt "List files in src/" --cwd .
```

Use `--trajectory-out /tmp/trajectory.jsonl` for Harbor trajectory parsing.

## Run Terminal Bench with RevCode

Pass API keys into the container with `--env-file` (Harbor does not read `.env` automatically):

```bash
harbor run -d "terminal-bench/terminal-bench-2" \
  --agent-import-path eval.revcode_agent:RevCodeAgent \
  --env-file .env \
  --n-concurrent 1
```

### KV Store smoke test (single local task)

```bash
# Oracle baseline (no API key needed)
harbor run -p eval/kv-store-grpc -a oracle -y --job-name oracle-kv-store

# RevCode agent (requires Z_AI_API_KEY in .env)
harbor run -p eval/kv-store-grpc \
  --agent-import-path eval.revcode_agent:RevCodeAgent \
  --env-file .env -y --n-concurrent 1 \
  --job-name revcode-kv-store
```

The RevCode adapter runs the agent with `--cwd /app` so file tools resolve to the task workspace (Terminal Bench tasks use `WORKDIR /app`).

## Providers

RevCode supports multiple providers:

```bash
npm run dev -- --provider zai --model glm-4.7
npm run dev -- --provider anthropic --model claude-sonnet-4-20250514
npm run dev -- --provider local-test
```

Local test mode accepts `/tool <name> <json>` commands for tool testing without API keys.

## Automated benchmark recording

```bash
# Run and record RevCode on KV Store
python3 eval/run_benchmark.py --agent revcode

# Run and record oracle baseline
python3 eval/run_benchmark.py --agent oracle

# Parse an existing job directory
python3 eval/run_benchmark.py --record-only jobs/oracle-kv-store --agent oracle
```

Results append to [`eval/results/benchmarks.jsonl`](results/benchmarks.jsonl). See [`eval/BENCHMARK_FAILURES.md`](BENCHMARK_FAILURES.md) and [`eval/PERFORMANCE.md`](PERFORMANCE.md) for analysis.
