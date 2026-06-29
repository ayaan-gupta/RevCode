# RevCode Memory Management Design

This document describes the planned memory system for RevCode: sliding context, importance ranking, compaction, and retrieval. Implementation is a follow-up milestone; this spec defines integration points with the existing agent loop in `src/agent/agent.ts` and trajectory JSONL format.

## Goals

- Keep long-running agent sessions within model context limits without losing task-critical information.
- Prefer retaining mutations, errors, and goal-relevant reads over exploratory noise.
- Enable selective re-injection of past context instead of replaying full history.

## Sliding context window

| Parameter | Proposed value | Notes |
|-----------|----------------|-------|
| Max context size | 128k tokens (model-dependent) | Track estimated tokens on system prompt + messages + tool results |
| Hard cap behavior | Block new tool results until compaction runs | Never truncate system prompt or current user objective |
| Eviction policy | FIFO on raw tool output after compaction | Lowest-importance events evicted first within FIFO tie-break |
| Summarization trigger | 70% of max context | Summarize tool results older than 8 turns |
| Compaction trigger | 80% of max context | Apply ranked compaction (below) |

### Token estimation

Use a lightweight heuristic (chars / 4) or model-specific tokenizer when available. Recompute after each assistant turn and each tool result append.

## Memory importance ranking

Every tool call and tool result receives metadata at write time:

```json
{
  "tool": "edit_file",
  "importance": 0.92,
  "goal_relevance": 0.95,
  "recency": 1.0,
  "tool_type": "mutation",
  "affected_files": ["server.py"],
  "timestamp": "2026-06-29T21:05:12.000Z",
  "dependencies": ["kv-store.proto"]
}
```

### Scoring heuristic

```
importance = 0.4 * goal_relevance + 0.3 * recency + 0.3 * tool_weight
```

| Tool type | tool_weight |
|-----------|-------------|
| edit_file, write_file | 1.0 |
| shell (exit != 0) | 0.9 |
| shell (success) | 0.5 |
| read_file (path in instruction) | 0.7 |
| read_file (exploratory) | 0.3 |
| grep, glob, list_directory | 0.2 |
| delete_file | 0.8 |

**Goal relevance:** keyword overlap between tool arguments (paths, query) and the active task instruction / current objective string.

**Recency:** exponential decay `exp(-turns_since / 10)`.

**Dependencies:** if edit targets a file previously read in this session, boost importance by 0.1.

### Trajectory schema extension

Add optional fields to `TrajectoryEvent` in `src/agent/agent.ts`:

```typescript
interface TrajectoryEvent {
  // ... existing fields ...
  importance?: number;
  goal_relevance?: number;
  tool_type?: "mutation" | "read" | "search" | "shell" | "other";
  affected_files?: string[];
}
```

## Compaction strategy (at 80% capacity)

1. **Preserve verbatim:** system prompt, latest user objective, last 3 assistant messages, all failed tool errors, all mutations in the last 5 turns.
2. **Summarize:** read/grep/list results with importance < 0.4 → one-line summary ("Read server.py: 40 lines, defines Server class").
3. **Discard:** duplicate directory listings, repeated identical grep queries, successful shell output older than 10 turns unless referenced by a later edit.
4. **Re-index:** update importance scores after compaction; store compacted summaries in a sidecar `compacted_memory.jsonl` keyed by turn range.

### Compaction prompt

Use a short LLM call (or rule-based template) to merge low-value blocks:

> Summarize the following tool results in ≤2 sentences each, keeping file paths, error messages, and numeric outcomes.

## Memory retrieval

Instead of loading full history on every turn:

| Always inject | Conditionally retrieve |
|---------------|------------------------|
| System prompt | Top-K edits by importance (K=5) |
| Current task instruction | Files mentioned in instruction not read recently |
| Last 2 turns verbatim | Recent errors (last 3 failures) |
| Active objective string | Related chunks from knowledge graph (future) |

**Retrieval query:** concatenate current instruction + last assistant message + open error strings → rank prior events by embedding similarity (future) or keyword match (initial).

**Integration point:** new `MemoryStore` module called from `Agent.runTask()` before `llm.complete()` to build the message list from stored events + retrieved snippets.

## Implementation phases

1. **Phase 1:** Token counting + trajectory metadata (importance fields).
2. **Phase 2:** Rule-based compaction at 80% without LLM summarization.
3. **Phase 3:** LLM summarization for low-value blocks at 70%.
4. **Phase 4:** Vector retrieval + knowledge graph (see appendix).

## Open questions

- Should compaction run synchronously (adds latency) or async between turns?
- Persist memory across Harbor trials or per-session only? (Recommend per-session initially.)
- How to handle multi-file tasks where grep exploration is essential — boost importance when grep precedes an edit within 2 turns.

---

## Appendix: Knowledge graph prototype (research)

Justin suggested a miniature knowledge graph for code-aware retrieval. **Not implemented in this milestone** — architecture decision only.

### Pipeline

```
Source files
    ↓
Tree-sitter parse (TS + Python grammars)
    ↓
Chunk by function / class / top-level block
    ↓
Embedding model (e.g. text-embedding-3-small or local bge-small)
    ↓
Vector store (LanceDB recommended — embedded, no server)
    ↓
Similarity search at task start + after each edit
    ↓
Inject top-K chunks into agent context
```

### Stack comparison

| Tool | Pros | Cons |
|------|------|------|
| **LanceDB** | Embedded, fast local dev, Python + TS clients | Newer ecosystem |
| Chroma | Simple API | Heavier for embedded use |
| FAISS | Fast search | No metadata store alone |
| Qdrant | Production-grade | Requires server for full features |

**Recommendation:** LanceDB + tree-sitter for RevCode Phase 4.

### Integration points

1. **Pre-task:** index task workspace (`/app` in Harbor) before first LLM call; retrieve chunks matching instruction keywords.
2. **Post-edit:** re-index changed files; link graph edges (file → symbol → dependency imports).
3. **Compaction handoff:** when evicting a full file read from context, retain pointer to chunk IDs in knowledge graph for later retrieval.

### Graph schema (minimal)

```
(FileNode) --CONTAINS--> (SymbolNode)
(SymbolNode) --IMPORTS--> (SymbolNode)
(ToolEventNode) --MODIFIED--> (FileNode)
```

### Deferred work

- Choose embedding model and dimension budget vs. context window.
- Benchmark retrieval precision on Terminal Bench tasks.
- Wire into Harbor adapter only after in-process memory compaction is stable.
