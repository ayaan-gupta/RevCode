# Parallel Universes

A **universe** is an isolated, recorded copy of your project in which the agent runs with full freedom. Nothing reaches your real project until you **land** it.

## Why

Permission prompts are the usual answer to "what if the agent does something dumb?", and they fail both ways: people click through them (approval fatigue) or switch to `--yolo` (data-loss stories). Universes change the question: let the agent do anything *to a copy*, and review a single changeset at the end.

## How it works

```
~/.revcode/universes/<id>/
  meta.json        identity, base snapshot, lineage
  work/            the copy the agent's cwd points at
  shadow.git/      bare git repo that snapshots work/ at every checkpoint
  timeline.jsonl   checkpoints, prompts, receipts — the replayable record
```

- **Creation.** Git projects: tracked + untracked-not-ignored files are copied (reflinked where the filesystem supports it). Other directories: copied minus caches/dependency dirs. `node_modules`, `.venv`, `venv` are *symlinked* so tests still run — these are shared with your project (shown in `universes show`). Files over 25 MB are skipped, and projects over 150k files or 2 GB are refused.
- **Checkpoints.** After every tool call that can change state, the work copy is snapshotted into the shadow repo (a bare repo with a fixed identity, ignoring your git config and hooks — your own `.git` is never touched). Each checkpoint records the tool, a summary, the exit code for shell commands, and the conversation length.
- **Rewind.** `/rewind <n>` restores files to checkpoint *n* and trims the conversation to a consistent point (never mid-tool-call). The state before the rewind is itself checkpointed, so a rewind is undoable.
- **Fork.** `/fork [n]` clones the shadow repo (hardlinked) into a sibling universe at that point and writes a session you can resume with `revcode -r <session>`.
- **Land.** Compares three versions of every changed file: BASE (project when the universe was created), THEIRS (universe now), OURS (your project now).
  - project untouched → write the universe version;
  - project edited elsewhere in the file → `git merge-file` 3-way merge, reported as "auto-merged";
  - overlapping edits, edit-vs-delete, both-added-differently → **conflict**: left untouched by default (`--markers` writes conflict markers, `--theirs` takes the universe version);
  - exec bits and symlinks are preserved; paths that would escape the project (including via symlinked directories) are refused.
  After a clean, complete land the merge base moves forward, so you can keep working and land again.
- **Receipts.** Every turn's receipt is built from evidence, not from the model's say-so: the commands that ran and their exit codes, files that actually changed (from the snapshots), whether a check ran *after* the last change, and test-file modification warnings.
- **Replay & compare.** `replay` forks from the base checkpoint and re-runs the recorded prompts with another model/profile; `compare --verify "<cmd>"` runs your command in both results and reports PASS/FAIL beside effort and file differences.
- **Share.** `universes share` writes one self-contained HTML file (no external requests): prompts, every checkpoint with its diff, receipts, final changeset.

## Commands

```bash
revcode --universe          # or: "universe": true in .revcode/config.json
```

The agent gets a private copy of your project (tracked + untracked files; dependency dirs like `node_modules` are symlinked for speed). Every mutating tool call is checkpointed into a shadow git repo, so the whole run is a timeline you can navigate:

| In a session | From the shell | What it does |
| --- | --- | --- |
| `/diff [full]` | `revcode universes diff <id>` | changeset vs. your project |
| `/land [paths] [--markers\|--theirs]` | `revcode universes land <id>` | apply it, with a **3-way merge** if you edited the project meanwhile; real conflicts are never overwritten |
| `/checkpoints`, `/rewind <n>` | `revcode universes show <id>` | jump files **and conversation** back to any step (undoable) |
| `/fork [n]` | `revcode universes fork <id> [n]` | branch a sibling universe |
| — | `revcode universes replay <id> --model X` | re-run the same prompts from the same starting point on another model |
| — | `revcode universes compare <a> <b> --verify "pytest -q"` | side-by-side effort, file differences, and a real pass/fail |
| — | `revcode universes share <id>` | self-contained HTML replay of the run |
| `/discard` | `revcode universes discard <id>` | throw it away |

Every turn ends with a **receipt**: commands run with exit codes, files actually changed, whether anything was verified *after* the last change, and warnings such as "modified an existing test file".

## Guarantees

- File tools in a universe are confined to the work copy (absolute paths and `..` are rejected).
- Landing never overwrites a file you changed in a way that conflicts, and never writes outside the project root.
- Your project's `.git` is not read for state beyond listing files at creation, and never written.

## Limits (read these)

- **Isolation is for your project tree, not the machine.** A shell command can still `cd /` and modify things elsewhere, install system packages, or talk to the network. Universes record and contain *file* changes under the project; they are not a security sandbox. (Container/bwrap hardening is a possible future layer; permission rules and the catastrophic-command refusal still apply.)
- Symlinked dependency dirs are shared: `npm install` inside a universe changes your real `node_modules`.
- Background processes started in a universe are not rewound.
- Ignored files (build output, `.env`, local databases) are not copied, so a universe may lack config your tests need. Add them to the project or copy them in.
- Snapshots use `git add -A` per tool call; on very large trees checkpoints take noticeable time.
