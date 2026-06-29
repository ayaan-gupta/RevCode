# RevCode Benchmark Performance Notes

Measurements from KV Store gRPC Harbor runs (June 2026).

## Oracle baseline (`jobs/oracle-kv-store`)

| Metric | Value |
|--------|-------|
| Total job runtime | ~46s |
| Agent setup | N/A (oracle runs `solve.sh` directly) |
| Agent execution | ~seconds (shell script) |
| Verifier | 7/7 passed |

## RevCode — passing run (`jobs/revcode-kv-store-v4`)

| Metric | Value |
|--------|-------|
| Total job runtime | ~20m 49s |
| Agent setup | ~110s |
| Agent execution | ~19m (includes post-task verification loops) |
| Tool calls | 9 |
| Verifier | **7/7 passed**, reward `1.0` |
| Effective solve time | ~3 min (files created by 22:00; agent continued verifying) |

## RevCode — partial run (`jobs/revcode-kv-store-v2`)

| Metric | Value |
|--------|-------|
| Total job runtime | ~3m 14s |
| Tests passed | 5/7 (proto field `val` vs `value`) |

## RevCode — timeout before cwd fix (`jobs/revcode-kv-store`)

| Metric | Value |
|--------|-------|
| Total job runtime | ~17m 7s |
| Environment setup | ~1s |
| Agent setup (install) | ~110s (`apt-get`, `npm install`, `npm run build`) |
| Agent execution | 900s (hit timeout, verifier not run) |
| Outcome | `AgentTimeoutError` |

## Bottleneck analysis

### 1. Agent setup dominates cold starts (primary)

Each Harbor trial runs in a fresh container. `RevCodeAgent.install()`:

- Installs Node 20 via apt (~30–60s)
- Uploads full repo to `/opt/revcode`
- Runs `npm install && npm run build` (~50–70s)

**Impact:** ~2 minutes consumed before the first LLM call. For a 900s agent budget, only ~790s remain for tool loop.

**Mitigations (future):**

- Pre-bake a Docker image with Node + built RevCode
- Cache `node_modules` in a volume
- Split setup timeout from execution (Harbor already tracks these separately)

### 2. LLM latency (secondary)

Local headless test (cwd `/tmp/kv-bench-app`, not `/app`) created all task files in ~1 minute of wall time but continued running 12+ minutes — the model keeps iterating after task completion or runs long shell waits.

**Estimated per-iteration cost:** 30–60s (Z.ai GLM API round-trip + tool execution)

**With 25 max iterations:** theoretical upper bound ~12–25 minutes of agent execution.

### 3. Shell tool blocking (tertiary)

`server.py` reference uses `server.wait_for_termination()`. If the agent runs `python server.py` in the foreground without `&`, the shell tool blocks up to **120s** per attempt.

**Mitigation:** system prompt already says to background long-running servers; consider detecting `wait_for_termination` patterns in shell commands.

### 4. No in-agent API retry

Transient API failures fail immediately; Harbor job retry excludes `AgentTimeoutError`. Add 2–3 retries with backoff in `src/llm/client.ts` for 429/5xx.

## Recommended metrics to track (per run)

| Metric | Source |
|--------|--------|
| Startup time | Harbor `agent_setup` timestamps in trial `result.json` |
| Agent execution time | Harbor `agent_execution` timestamps |
| Tool call count | Trajectory JSONL `type == tool_call` |
| Avg tool latency | Delta between `tool_call` and `tool_result` timestamps in trajectory |
| Avg model response time | Delta between last `tool_result` and next `assistant`/`tool_call` |
| Total solve time | Job `stats.duration_sec` in `result.json` |

## Configuration changes applied

- `[agent] timeout_sec` raised to **1800** in `eval/kv-store-grpc/task.toml` for RevCode trials (slow setup + LLM loop).
- `--cwd /app` added to Harbor adapter so agent time is not wasted on wrong-path recovery.
- System prompt: use exact field names; stop calling tools after task summary.
- LLM fetch timeout: 180s per request (`AbortSignal.timeout` in Z.ai client).

## Code improvements checklist

| Question | Status |
|----------|--------|
| Tool calling deterministic? | Z.ai: API tool_calls + XML/inline fallbacks — adequate |
| JSON parsing robust? | Fallback on parse failure; could log to trajectory |
| Malformed tool call recovery? | Error returned to model — OK |
| Retries implemented? | Harbor job-level only — add in-agent API retry |
| Tool errors surfaced? | Yes (`{ error: "..." }`) |
| Execution state persisted? | Trajectory JSONL only — memory system next |
