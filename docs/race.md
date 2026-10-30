# Race

```bash
revcode race "fix the failing test"
```

Runs several attempts at the same task at once, each in its own [private copy](universes.md). When they finish, each result is checked with your tests, the attempts are ranked, and you choose whether to apply the best one.

```
⌬ Race 3 attempts · check: npm test · cap $1.00
  slugify is broken. make the tests pass

 #3 glm-5.2              ✔ passed         0:56   6 steps   $0.02  1 file +6 −1  ❯ best
 #2 glm-5.2              ✔ passed         0:50   7 steps   $0.02  1 file +6 −1
 #1 glm-5.2              ✔ passed         1:02  10 steps   $0.02  1 file +7 −1
  spent $0.06 of $1.00 in total

Apply #3 to your project? [Y/n, d = show diff, or an attempt number]
```

## Why

Models are inconsistent: the same model, given the same task, sometimes gets it right and sometimes doesn't. Several tries with a real check picks a good result much more often than one try. With a cheap model, three tries usually cost less than one try on a frontier model. Different models can also race each other on your own code.

## Options

| Flag | Default | |
| --- | --- | --- |
| `--tries <n>` | 3, or one per model | number of attempts (up to 12) |
| `--models a,b` | `--model` | models to use, in turn. Name a provider with a prefix: `anthropic:claude-sonnet-5-5`, `ollama:qwen3:8b` |
| `--check "<cmd>"` | your project's test command | how to tell a good result. Found from `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`/pytest, a `Makefile` `test:` target, and others |
| `--max-cost <dollars>` | none | one cap for the whole race; every attempt stops before crossing it |
| `--parallel <n>` | all | attempts running at the same time |
| `--yes` | | apply the best attempt without asking (only if one qualifies, see below) |
| `--output-format json` | | a JSON summary for scripts |

## How the best attempt is picked

1. It passed the check and changed something.
2. It left existing test files alone.
3. It finished on its own (didn't hit a limit).
4. Other attempts wrote the same code (when attempts agree, they're usually right).
5. It's the smaller change.
6. It cost less.

Without a check command, an attempt only counts if its own last test run, after its last edit, passed.

## Details

- Every attempt starts from the same files: one copy is made and the others are forks of its starting point.
- Checks run one at a time, so test suites that use fixed ports don't collide.
- In unattended attempts, anything that reaches outside the copy (push, deploy, sudo…) is refused.
- Ctrl+C stops every attempt and keeps the copies. Press it again to quit at once.
- After applying, the copies are cleaned up. If you don't apply, they're kept: `revcode universes diff <id>` / `land <id>`.
