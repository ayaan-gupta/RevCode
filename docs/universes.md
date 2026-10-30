# Private copies (universes)

A **universe** is a private, recorded copy of your project. RevCode edits files and runs commands there without asking, and nothing reaches your real project until you **land** it.

## Why

Permission prompts are the usual answer to "what if the agent does something dumb?", and they fail both ways: people click through them or turn them off. A copy changes the question: the agent can do anything *to the copy*, and you review one changeset at the end.

## When you get a copy

`revcode` in a git project works on a copy by default. The first line of the session says so:

```
⌬ Working in a private copy of this project. Your files change only when you /land.
```

It works in the project directly instead, and asks before changes, when the folder isn't a git repository, uses git submodules, has more than 25,000 files or 1 GB to copy, or is your home folder. The session says which in one line.

| You want | Do this |
| --- | --- |
| a copy even in those cases (limits rise to 150,000 files / 2 GB) | `revcode --universe` or `"universe": true` in `.revcode/config.json` |
| never a copy | `revcode --no-universe` or `"universe": false` |

`revcode run` works in the project unless you pass `--universe` or `--land-if`.

## What the copy has

- Your tracked and untracked (not ignored) files, plus ignored `.env` files, since apps and tests usually need them. Ignored files never land.
- `node_modules`, `.venv` and `venv` are linked, not copied, so tests run straight away. They are shared with your project: `npm install` in the copy changes your real `node_modules`.
- **Its own git repository** that mirrors yours: same history, branch, staged changes and remotes, so `git log`, `diff`, `blame` and `status` work. It borrows your repository's objects read-only and never writes to your `.git`. Commits made in the copy stay in the copy; landing applies file changes, not commits.

## What still asks

In a copy the agent doesn't ask before edits or commands. It still asks before anything that reaches outside the copy:

- pushing (`git push`), changing things on GitHub (`gh pr create`, `gh api -X POST`…)
- publishing packages, pushing images, deploying (`kubectl apply`, `terraform apply`, `vercel --prod`…)
- `sudo`, `ssh`/`scp`/`rsync` to other machines, global installs (`npm i -g`, `brew install`…)
- using your real project folder, or writing anywhere outside the copy except temp folders

In unattended runs (`run --land-if`, `race`) these are refused with the reason, and the agent is told to do the work inside the copy. `--allow "shell(git push*)"` permits one deliberately. This is a careful check, not a sandbox: network access and processes are not isolated.

## Leaving

`/exit` with changes still in the copy asks whether to apply them, keep them for later (`revcode -r <session>` picks up where you left off), or stay. Copies where nothing changed are removed when you quit.

## Commands

| In a session | From the shell | What it does |
| --- | --- | --- |
| `/diff [full]` | `revcode universes diff <id>` | what changed, compared with your project |
| `/land [paths] [--markers\|--theirs]` | `revcode universes land <id>` | apply it, with a **3-way merge** if you edited the project meanwhile; conflicts are never overwritten |
| `/checkpoints`, `/rewind <n>` | `revcode universes show <id>` | jump files **and conversation** back to any step (undoable) |
| `/fork [n]` | `revcode universes fork <id> [n]` | try another approach from any checkpoint |
| — | `revcode universes replay <id> --model X` | re-run the same prompts from the same starting point on another model |
| — | `revcode universes compare <a> <b> --verify "pytest -q"` | effort, file differences and a real pass/fail, side by side |
| — | `revcode universes share <id>` | self-contained HTML replay of the run |
| `/discard` | `revcode universes discard <id>` | throw it away |
| — | `revcode run "<task>" --land-if "<check>"` | unattended: apply only if the check passes ([below](#apply-only-if-the-check-passes)) |
| — | `revcode race "<task>"` | several attempts in parallel copies ([race](race.md)) |

## Apply only if the check passes

```bash
revcode run "upgrade lodash and fix what breaks" --land-if "npm test"
```

The agent works on a copy. When it's done, the check runs in the copy, and the changes are applied to your project only if it exits 0. It's all or nothing: if your project changed meanwhile in a way that conflicts, nothing is applied. On failure the copy is kept (`revcode universes diff <id>` shows it). Exit code 0 means applied, or nothing to apply; 1 means not applied. `--output-format json` adds a `landIf` object with the status, files and check result. Good for cron jobs and CI.

## How it works

```
~/.revcode/universes/<id>/
  meta.json        identity, base snapshot, lineage
  work/            the copy the agent works in (with its own .git)
  shadow.git/      bare git repo that snapshots work/ at every checkpoint
  timeline.jsonl   checkpoints, prompts, receipts: the replayable record
```

- **Checkpoints.** After every tool call that can change files, the copy is snapshotted into the shadow repo (fixed identity, ignores your git config and hooks). Each checkpoint records the tool, a summary, the exit code for shell commands, and the conversation length.
- **Rewind.** `/rewind <n>` restores files to checkpoint *n* and trims the conversation to a consistent point. The state before the rewind is checkpointed too, so a rewind can be undone.
- **Fork.** `/fork [n]` clones the shadow repo (hardlinked) into a sibling copy at that point and writes a session you can resume with `revcode -r <session>`.
- **Land.** Compares three versions of every changed file: the project when the copy was made, the copy now, and the project now.
  - project untouched → write the copy's version;
  - project edited elsewhere in the file → 3-way merge, reported as "auto-merged";
  - overlapping edits, edit vs. delete, both added differently → **conflict**: left untouched (`--markers` writes conflict markers, `--theirs` takes the copy's version);
  - exec bits and symlinks are kept; paths that would escape the project are refused.
  After a clean, complete land the starting point moves forward, so you can keep working and land again.
- **Receipts.** Every turn ends with evidence, not the model's say-so: commands that ran with exit codes, files that actually changed, whether a check ran *after* the last change, and warnings such as "modified an existing test file".

## Guarantees

- File tools in a copy are confined to it (absolute paths and `..` are refused).
- Landing never overwrites a file you changed in a way that conflicts, and never writes outside the project.
- Your `.git` is only read (to copy files and mirror history), never written.

## Limits

- **It isolates your project's files, not the machine.** See [What still asks](#what-still-asks).
- Linked dependency folders are shared with your project.
- Background processes started in a copy are not rewound.
- Ignored files other than `.env` (build output, local databases) are not copied.
- Snapshots run `git add -A` after each change; on very large trees that takes noticeable time.
