# Terminal-Bench notes

## What changed (harness-level, from studying Terminus-2, Codex, OpenCode, oh-my-pi, deepagents and others)

Defects found and fixed in RevCode itself:

- **Stdin theft in the persistent shell.** The command and the completion sentinel shared one stdin pipe, so any command that read stdin (`cat`, bare `python3`, an apt prompt) swallowed the sentinel and hung until the timeout, then the session was reset and background servers died. Commands are now sourced from a temp file with stdin closed; reproduced the hang on the original code (4 s timeout + session reset) and verified the fix.
- Shell `timeout` was in milliseconds (a model asking for `300` got 0.3 s); it is now seconds like every other harness.
- Tool results reached the model as escaped JSON (`\n`, `\"`), inviting `oldText` miscopies; they are now rendered as plain text.
- Diffs returned the whole old file as `-` and the whole new file as `+`; real unified diffs now.
- A turn with no tool calls ended the run: an empty or length-truncated reply, or "Let me run the tests:" with no call, counted as "done". Both are now detected and nudged; truncated tool calls are never executed.
- File tools rejected absolute paths outside cwd (already cost a benchmark run); headless/yolo runs are unrestricted.
- Hard 50-iteration cap; replaced by a wall-clock budget with nudges at 50/80/92% and a clean stop near the limit (`REVCODE_TIME_BUDGET_SEC`).
- Old file contents and shell output were never compacted; now elided from history, with an LLM handoff summary as a fallback and automatic recovery from "context too long" errors.

Added: environment snapshot at start, pre-completion audit of the original task (headless), loop guard, argument repair, `task` subagent, optional `apply_patch`/hash-anchored edit modes.

## Integrity

Benchmark runs use `--no-instructions --no-hooks --no-mcp --profile default` (unless you ship a tuned profile via `REVCODE_EVAL_PROFILE`), so nothing in a task directory — `AGENTS.md` included — is read as extra guidance. There are no per-task hacks or answer keys anywhere in the harness. (A 2026 audit found at least one leaderboard harness inflated by loading answer-key `AGENTS.md` files; don't do that.)

## What is NOT known

- **No real-model Terminal-Bench score has been measured for this version.** The development environment had no model credentials and no Docker-in-Docker for Harbor. Everything above is verified by unit/integration tests with scripted models, and the shell fix by reproduction. Expect real runs to surface new issues.
- Whether `apply_patch` or hashline editing helps a given model is exactly what `revcode tune` is for; the literature is mixed and model-specific (some harnesses disable hashline for GLM-class models).

## Running it

```bash
npm run bundle
export PYTHONPATH="$(pwd)"
export REVCODE_EVAL_MODEL=glm-5.2 REVCODE_EVAL_PROVIDER=zai
export REVCODE_TIME_BUDGET_SEC=1500            # match the task's agent timeout, minus margin
# optional: ship a tuned profile into the container
# export REVCODE_EVAL_PROFILE=~/.revcode/profiles/zai__glm-5.2.json
harbor run -d terminal-bench/terminal-bench-2 \
  --agent-import-path eval.revcode_agent:RevCodeAgent --env-file .env --n-concurrent 1
```
