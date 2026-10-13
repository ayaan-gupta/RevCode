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

## Measured so far (GLM-5.2 via Z.ai, Terminal-Bench 2, Harbor)

Real runs surfaced harness problems that no scripted test could, and fixed them:

- **Reasoning runaway.** GLM-5.2 sometimes spends its whole output budget thinking (one turn = 100–570 s). Non-streaming requests also sent no bytes until the generation finished, so slow turns tripped the 180 s header timeout and restarted from scratch. The engine now always streams, retries stalled streams, and exposes a `thinking` profile knob (`off` sends Z.ai's thinking switch).
- **Time budget was soft.** It was only checked between iterations, so an in-flight call or command could run past it (one trial ran the full 900 s with no trajectory). It is now a hard deadline that aborts the call, interrupts the shell and ends the turn cleanly.
- **Hard-coded `--cwd /app`.** Task images differ (`/app`, `/app/subdir`, `/workspace`); with a missing directory every shell call failed. The adapter now uses the container's actual working directory, and RevCode refuses a nonexistent `--cwd` and says why a shell could not start.
- **EOL base images.** Debian 11 images 404 on apt; the adapter falls back to `archive.debian.org` and retries.

Seeded 16-task sample (`random.Random(0)` over tasks with a 900 s limit, excluding `fix-git`; one trial per task, 780 s budget):

| Configuration | Passed |
| --- | --- |
| Before the fixes above | 9/16 |
| + streaming, retry, hard deadline (thinking on) | 13/16 |
| + thinking off | 14/16 (2 of the 16 were also hit by the `--cwd` bug; `prove-plus-comm` passes in 62 s once fixed) |

Caveats: n = 16 with one trial each. The step from 9 to 13 is 4 tasks gained and none lost (exact sign test p ≈ 0.13), and thinking on vs off differs by one task, which is noise. What *is* clear is speed: thinking off finished the sample in 22 min vs 40 min. Run-to-run variance on single tasks is real (several tasks flip between runs).

## What is NOT known

- A full-benchmark score is reported separately below if a full run has completed; do not extrapolate the sample to it.
- Whether thinking-off is better on the long (30–60 min) tasks, where deliberate reasoning might matter more.
- Whether `apply_patch` or hashline editing helps GLM; that is what `revcode tune` is for, but the built-in Dyno suite is too easy for GLM-5.2 (16/16 at baseline), so it has no headroom to tune on.

## Running it

```bash
npm run bundle
export PYTHONPATH="$(pwd)"
export REVCODE_EVAL_MODEL=glm-5.2 REVCODE_EVAL_PROVIDER=zai
export REVCODE_TIME_BUDGET_SEC=1500            # match the task's agent timeout, minus margin
# optional: ship a profile into the container (e.g. thinking off, which sped up GLM-5.2 ~2x here)
# export REVCODE_EVAL_PROFILE=$(pwd)/eval/profiles/glm-thinking-off.json
harbor run -d terminal-bench/terminal-bench-2 \
  --agent-import-path eval.revcode_agent:RevCodeAgent --env-file .env --n-concurrent 1
```

### Running where containers have no direct internet

If containers reach the network only through a TLS-intercepting egress proxy, give Docker the proxy
(`~/.docker/config.json` → `proxies`) and set `REVCODE_EVAL_CA_BUNDLE=<host path to the proxy CA>`. The
adapter then trusts that CA for apt (verification stays on) and rewrites apt mirrors to https. Also set
`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` and `PIP_CERT`
to `/opt/revcode/ca.crt` for the whole environment (Harbor job config: `environment.env`) so the verifier's
own downloads (e.g. `uv`) trust it too. `REVCODE_EVAL_BUNDLE` selects an alternate bundle for A/B runs.
