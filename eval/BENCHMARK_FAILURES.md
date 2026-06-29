# Benchmark Failure Analysis

## KV Store gRPC — prior RevCode run (2026-06-22)

**Job:** `jobs/2026-06-22__14-33-33/kv-store-grpc__wT6wTTG/`  
**Score:** 2/7 tests passed, reward `0.0`

### Per-test breakdown

| Test | Result | Category | Root cause |
|------|--------|----------|------------|
| `test_proto_file_creation` | FAIL | **Environment / harness integration** | Expected `/app/kv-store.proto`; agent wrote to `/opt/revcode/app/kv-store.proto` |
| `test_protobuf_generation` | FAIL | **Environment / harness integration** | Generated `kv_store_pb2*.py` under `/opt/revcode/app/`, not `/app/` |
| `test_server_file_creation` | FAIL | **Environment / harness integration** | `server.py` created at wrong path |
| `test_grpc_protocol_handshake` | FAIL | **Downstream of path bug** | Verifier imports from `/app`; `ModuleNotFoundError: No module named 'kv_store_pb2'` |
| `test_grpc_server_functionality` | FAIL | **Downstream of path bug** | Same import error |
| `test_grpc_tools_installation` | PASS | — | Agent ran `pip install grpcio==1.73.0 grpcio-tools==1.73.0` |
| `test_real_grpc_server_running` | PASS | — | Server bound to port 5328 (same container, wrong directory) |

### Why the agent assumed files were in the right place

1. The task instruction specifies absolute paths under `/app/`.
2. RevCode's Harbor adapter ran with default cwd `/opt/revcode` (repo install path).
3. First tool call `write_file("/app/kv-store.proto")` was **rejected** by path sandboxing: `Path escapes the working directory`.
4. The agent listed `.`, saw the RevCode repo, and created `app/` as a subdirectory — reasonable recovery given the wrong cwd, but incorrect for Terminal Bench.

### Should it have generated `kv_store_pb2`?

**Yes.** The agent did run `protoc` and generate bindings, but in the wrong directory. The harness does not pre-generate protobuf modules; the agent must create the proto file and run `grpc_tools.protoc`.

### Should it have installed something?

**Partially done correctly.** gRPC packages were installed system-wide (test passed). The missing piece was file placement, not missing pip packages.

### Was it a reasoning mistake?

**No — primarily a harness bug.** The agent followed the instruction literally, hit sandbox rejection, and adapted logically. A secondary risk on retry is proto field naming (`value` vs `val` in `SetValRequest`); the reference solution and tests require `value`.

---

## KV Store gRPC — RevCode timeout (2026-06-29, pre-fix)

**Job:** `jobs/revcode-kv-store/`  
**Score:** AgentTimeoutError after 900s (verifier never ran)

| Issue | Category | Fix |
|-------|----------|-----|
| Agent execution exceeded 900s | **Timeout** | Increased `[agent] timeout_sec` to 1800 in local task config; RevCode needs ~2 min setup (npm install/build) plus slow LLM iterations |
| `PYTHONPATH` not set | **Environment** | Export `PYTHONPATH=$(pwd)` when running Harbor |
| `--cwd /app` missing (first attempt) | **Harness integration** | Fixed in `eval/revcode_agent.py` |

---

## Failure category summary

| Category | KV Store prior run |
|----------|-------------------|
| Environment / harness | Primary (wrong cwd) |
| Downstream missing files | 2 tests |
| Incorrect code generation | Possible secondary (`value` field) |
| Timeout | Second run |
| Missing dependency | No |
| Hallucinated file/module | No — files existed, wrong path |
| Wrong tool call | No |
| Parser issue | No |

---

## Oracle vs RevCode comparison (KV Store gRPC)

| Metric | Oracle | RevCode (v2) | RevCode (v4, passing) |
|--------|--------|--------------|------------------------|
| Success rate | 100% | 0% (5/7 tests) | **100% (7/7)** |
| Runtime | ~46s | ~3m 14s | ~20m 49s (agent hung on verification; killed to verify) |
| Total tests passed | 7/7 | 5/7 | **7/7** |
| Tool calls | N/A | 9 | ~10 |
| Failure types | N/A | Proto field `val` vs `value` | Agent exit code (NonZeroAgentExitCodeError) despite reward 1.0 |

**Passing job:** `jobs/revcode-kv-store-v4` — reward `1.0`, all verifier tests passed.

**Fixes applied:** `--cwd /app` in Harbor adapter; system prompt for exact field names and stop-after-done; LLM fetch timeout (180s).

Results are appended automatically by `eval/run_benchmark.py` to `eval/results/benchmarks.jsonl`.
