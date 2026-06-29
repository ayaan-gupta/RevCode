# Agent Anti-Patterns & Fixes

Stress-test fixture lives at `/tmp/agent_bench`:

```
/tmp/agent_bench/
  src/app.py
  src/util.py
  src/hidden.txt
  docs/readme.md
```

Recreate with:

```bash
mkdir -p /tmp/agent_bench/{src,docs}
echo 'def hello(): return "world"' > /tmp/agent_bench/src/app.py
echo 'import os' > /tmp/agent_bench/src/util.py
echo 'needle' > /tmp/agent_bench/src/hidden.txt
echo '# readme' > /tmp/agent_bench/docs/readme.md
```

Set `ANTHROPIC_API_KEY` in `.env`, then run `python3 agent.py` from the repo root.

---

## Task 1 — Find a file

**Prompt:** Find `hidden.txt` under `/tmp/agent_bench`.

| Anti-pattern | What goes wrong | Fix |
|---|---|---|
| `run_command("find ...")` before checking structure | Spawns shell search when one `list_directory` call would locate the file | `list_directory` schema says to use it when locating files by name; system prompt says list before read when paths are unknown |
| `read_file` on the result | Wastes a turn; user only asked for the path | `read_file` schema says not to use for discovery; only read when inspecting contents |

**Expected efficient path:** `list_directory("/tmp/agent_bench")` → `list_directory("/tmp/agent_bench/src")` → answer with path.

---

## Task 2 — Summarize all `.py` files

**Prompt:** Summarize each `.py` file in `/tmp/agent_bench/src`.

| Anti-pattern | What goes wrong | Fix |
|---|---|---|
| `run_command("ls")` instead of `list_directory` | Shell listing when a dedicated tool exists | `run_command` schema explicitly says not to use `ls` for directory listing |
| Reading files without listing first | May guess wrong filenames | System prompt: list before read when paths unknown |
| Re-reading same file after error | Loops on bad paths | Tool errors return as `tool_result` text so the LLM can recover without crashing |

**Expected efficient path:** `list_directory` → one `read_file` per `.py` file (2 calls here).

---

## Task 3 — Write a script and run it

**Prompt:** Write `lines.py` that counts lines in all `.py` files under `src`, then run it.

| Anti-pattern | What goes wrong | Fix |
|---|---|---|
| Multiple `write_file` calls to build one script | Partial writes, inconsistent state | `write_file` schema: write complete content in one call |
| Writes script but never runs it | User asked for output, not just the file | System prompt: write full file, then run it |
| No visibility into tool execution | Hard to debug during benchmarks | Executor prints `[tool_name(input)]` on each tool call |

**Expected efficient path:** `write_file` → `run_command("python3 /tmp/agent_bench/lines.py")`.

---

## Task 4 — Search for a string across files

**Prompt:** Find which files under `/tmp/agent_bench` contain `import`.

| Anti-pattern | What goes wrong | Fix |
|---|---|---|
| `read_file` on every file | O(n) tool calls, slow on large trees | System prompt + `run_command` schema: use `rg 'import' /tmp/agent_bench` |
| `run_command("grep -r ...")` when `rg` exists | Works but slower/noisier on large repos | Schema examples prefer `rg` |
| `grep` without `-r` | Misses nested files | Schema shows recursive search patterns |

**Expected efficient path:** `run_command("rg 'import' /tmp/agent_bench")` — one call.

---

## Task 5 — Count lines of code

**Prompt:** Count total lines in all `.py` files under `/tmp/agent_bench`.

| Anti-pattern | What goes wrong | Fix |
|---|---|---|
| `read_file` every `.py` and count in prose | Many round trips, truncation risk | System prompt: use `wc`/`find` via `run_command` |
| No size context on `read_file` results | LLM re-reads or guesses | `read_file` now prefixes `[path — N lines, M chars]` |
| `list_directory` with no entry count | LLM doesn't know scope | `list_directory` now prefixes `[path — N entries]` |

**Expected efficient path:** `run_command("find /tmp/agent_bench -name '*.py' -exec cat {} + | wc -l")` or `wc -l` on known files after one `list_directory`.

---

## Executor-level fixes

| Issue | Fix in `agent.py` |
|---|---|
| Huge tool output blows context | `MAX_TOOL_OUTPUT = 30000` with truncation marker |
| Tool crash kills the loop | `execute_tool` catches exceptions, returns `Error: ...` as result |
| Multi-step tool use | `run_tool_loop` keeps calling API until response has no `tool_use` blocks |
| Conversation grows unbounded | `/clear` resets to system prompt only |
| Debugging what the LLM sees | `/memory` dumps full messages list |

---

## Slash commands

| Command | Action |
|---|---|
| `/memory` | Print full messages list |
| `/tools` | Print tool JSON schemas |
| `/clear` | Reset to system prompt only |
| `/help` | List commands |

---

## Running live stress tests

```bash
cd /Users/ayaangupta/RevCode/RevCode
python3 -m pip install -r requirements.txt
# add key to .env
python3 agent.py
```

Run each task prompt above. Watch the `[tool_name(...)]` lines printed during execution. Use `/memory` after each task to inspect what was sent back to the model.

Flag any task that takes more than ~5 tool calls on this small fixture — that's a signal the schemas or system prompt need tightening.
