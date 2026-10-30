<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img src="docs/assets/logo-dark.svg" alt="RevCode" width="440">
  </picture>
</p>

<h3 align="center">Let it run. Keep what works.</h3>

<p align="center">
  RevCode never stops to ask permission, because nothing it does touches your files until you say so.<br>
  Every edit and command can be undone, and <code>revcode race</code> tries three times at once and keeps the one that passes your tests.
</p>

<p align="center">
  <img alt="1 MB, no dependencies" src="https://img.shields.io/badge/size-1_MB,_no_dependencies-a78bfa?style=flat-square">
  <img alt="Node 20 or newer" src="https://img.shields.io/badge/node-%E2%89%A520-5fa04e?style=flat-square">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

<p align="center">
  <img src="docs/assets/hero.svg" alt="RevCode fixing a failing test in a copy of the project: it reads the code, edits it, runs the tests, shows what it did, and applies the change." width="860">
</p>

<p align="center"><sub>A real session: RevCode fixes a failing test in a copy of the project, then the change is applied with <code>/land</code>.</sub></p>

## Install

```bash
git clone https://github.com/ayaan-gupta/RevCode && cd RevCode
npm install && npm run bundle
cp dist/revcode.mjs ~/.local/bin/revcode     # one file; anywhere on your PATH works
revcode                                      # the first run asks for a provider and an API key
```

Needs Node 20+, `git`, `ripgrep` and `bash` on Linux or macOS.

## How it works

<p align="center"><img src="docs/assets/universes.svg" alt="Your project stays as it is. RevCode works in a private copy, saving a checkpoint after every edit, and reports what it did. Then you apply the changes, go back, try another approach, re-run with another model, or throw it away." width="860"></p>

Run `revcode` in a git project. It builds a *universe*: a recorded copy of your project, uncommitted edits included, with your full git history inside.

1. **It never asks.** It edits and runs commands in the universe, so there is nothing to approve. Only actions that reach past it, like `git push`, deploying or `sudo`, still ask.
2. **It records everything.** Every edit and command is a checkpoint. `/rewind 3` puts the files *and* the conversation back to step 3.
3. **You keep what works.** `/land` merges the result into your project, around anything you changed meanwhile. Conflicting edits are never overwritten.

Keep coding while it works: your edits flow into the universe before each answer. Outside a git project, or with `--no-universe`, RevCode works in the folder directly and asks first, like other agents.

## Why not just a git worktree?

A worktree gives an agent a separate folder. A universe gives it a separate folder that also remembers, merges and races.

| | git worktree | RevCode universe |
| --- | --- | --- |
| Starts from | your last commit | your files right now: uncommitted edits, `.env` and dependencies included |
| Undo | the commits you remember to make | every edit and command, files and conversation together |
| Your edits while it works | it never sees them | brought in before each answer |
| Getting the result back | commit, merge, resolve | `/land`: a 3-way merge into your working files |
| Your repository | shares its branches and refs | read, never written |
| Several attempts | one worktree each, set up by hand | `revcode race`: three at once, tested, best one picked |
| Setup | `git worktree add`, reinstall dependencies | none, it's the default |

## Race

<p align="center"><img src="docs/assets/race.svg" alt="revcode race: three attempts fix a failing test at the same time, each in its own copy; all pass npm test, two wrote the same code, and the best one is applied." width="860"></p>

`revcode race "fix the failing test"` runs three attempts at once, each in its own copy. Your tests check every result, the best one is picked, and you choose whether to apply it. If a model gets a task right two times out of three, one of three tries almost always does, and three tries on a cheap model usually cost less than one on a frontier model. Race different models with `--models glm-5.2,anthropic:claude-sonnet-5-5`; cap the whole race with `--max-cost 1`.

## Features

- **Branch off any step.** `/fork 4` starts a second universe from checkpoint 4 to try a different approach.
- **Apply only if the tests pass.** `revcode run "upgrade lodash" --land-if "npm test"` works on a copy and changes your project only if the check passes. Made for scripts, cron jobs and CI.
- **A spending cap.** Every answer shows what it cost. `--max-cost 2` stops before a session spends more than $2; `/cost 5` sets one mid-session.
- **Try another model on the same task.** `revcode universes replay <id> --model claude-sonnet-5-5` re-runs your prompts from the same starting point, and `revcode universes compare` runs your tests on both results.
- **Tunes itself to your model.** `revcode tune` tests which edit format, prompt style and settings work best for the model you use, and keeps a change only if it still helps when re-checked.
- **Any model.** Z.ai GLM, Claude, OpenAI, OpenRouter, Ollama, or any OpenAI-compatible server.
- **Small.** The whole agent is one 1 MB file with no dependencies: copy it anywhere and run it. Claude Code, OpenCode and Gemini CLI each install about 100 to 300 MB.
- **Extensible.** `AGENTS.md`, MCP servers, skills, hooks and custom slash commands.

## Self-tuning

<p align="center"><img src="docs/assets/dyno.svg" alt="revcode tune: run a baseline, try one change at a time on the tasks that failed, then re-check the best change against a fresh baseline." width="860"></p>

The same model can score very differently depending on how the agent around it is set up. `revcode tune` runs a built-in set of coding tasks against your model, tries one setting at a time, and re-checks the winner against a fresh run so a lucky result can't fool it. The tuned settings load automatically from then on.

```bash
revcode tune --model glm-5.2 --dry-run      # show the plan without calling the model
revcode tune --model glm-5.2 --budget 150   # run it
```

## Docs

[Private copies](docs/universes.md) · [Race](docs/race.md) · [Self-tuning](docs/dyno.md) · [Terminal UI and keys](docs/tui.md) · [Benchmark notes](docs/terminal-bench.md) · [Reference](docs/reference.md)

## License

MIT. Some techniques and code are adapted from open-source projects; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
