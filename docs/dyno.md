# Dyno — self-tuning harness

The same model can score very differently depending on the *harness*: how edits are expressed, how the prompt is written, how tool schemas look, whether the harness double-checks "done". Public Terminal-Bench numbers show 10–18 point swings from the harness alone. Dyno makes those choices explicit data (a **profile**) and searches over them per model.

## The knobs (`src/harness/profile.ts`)

| Knob | Values | Effect |
| --- | --- | --- |
| `editMode` | `replace`, `patch`, `anchored`, `whole` | which edit tool(s) the model sees (exact/fuzzy replace, `apply_patch` envelope, hash-anchored line edits, whole-file rewrites) |
| `promptStyle` | `standard`, `terse`, `checklist` | system prompt shape |
| `toolSchema` | `full`, `flat` | tool schemas as authored vs. trimmed, required-first |
| `parallelTools` | on/off | concurrent read-only calls |
| `verifyGate` | on/off | challenge "done" once if files changed but nothing was run |
| `completionGate` | on/off | headless: audit against the original task before accepting "done" |
| `temperature` | 0, 0.2, 0.6 | sampling |

Only edit modes marked implemented in `AVAILABLE_EDIT_MODES` are explored.

## The suite (`src/dyno/suite`)

A set of small, deterministic coding tasks (edit robustness in big/CRLF/tricky-character/near-duplicate files, bug fixes against hidden tests, implement-from-spec, shell and multi-step jobs). Each task has a code grader — no LLM judges — and an **oracle**; the test suite proves each task fails untouched, passes after the oracle, grades idempotently, and rejects plausible cheats (e.g. deleting the tests).

## The search

1. **Baseline** — default profile on the full suite. If it already passes ≥95%, stop: nothing to gain.
2. **Search** — one knob at a time, on a *screen* of the baseline's failures plus a few passing tasks (regression guard), most impactful knobs first so a small budget still covers the likely winners. Keep a change if it passes more, or passes the same with ≥15% fewer tool calls.
3. **Confirm** — run the winner **and the baseline again** on the full suite and compare fresh against fresh. This matters: the screen is made of tasks the baseline *failed*, so a no-op change would look like an improvement just from regression to the mean. A test pins this behaviour.

The result reports fixed/regressed tasks and an exact sign-test p-value. With 16 tasks and one trial you need roughly 6 fixed vs. 0 regressed to reach p<0.05; the report says "could be chance" when it isn't, and `--trials` firms it up. If nothing holds up it keeps the defaults and says so.

## Using it

```bash
revcode tune --model glm-5.2 --dry-run           # plan only, no model calls
revcode tune --model glm-5.2 --trials 2 --budget 300 --card lift.md
REVCODE_TUNE_CONCURRENCY=4 revcode tune ...      # parallel runs
revcode profile show | reset
revcode run "..." --profile default              # ignore the tuned profile
```

Tuned profiles live in `~/.revcode/profiles/<provider>__<model>.json` with their evidence, and load automatically (`--profile auto`). The eval adapter can ship one into a benchmark container with `REVCODE_EVAL_PROFILE=<path>`.

## Safety

Benchmarking an agent means letting the model run shell commands and edit files **unattended** (yolo mode, in throwaway temp directories). The directories are disposable; the commands are not sandboxed. `revcode tune` says so and asks for confirmation (`--yes` to skip — for example inside a container, which is the recommended place to run it). The catastrophic-command refusal (`rm -rf /`, `mkfs`, …) still applies.

## Honest limits

- Tuned on a small synthetic suite, not on your repo; a gain here is evidence, not a guarantee, for your codebase.
- Results are model-stochastic; use `--trials` for borderline calls.
- A run costs real tokens (the dry run estimates run counts; the report prints actual token totals).
- The search is coordinate descent: it can miss interactions between knobs.
