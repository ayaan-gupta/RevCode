<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img src="docs/assets/logo-dark.svg" alt="RevCode" width="440">
  </picture>
</p>

<h3 align="center">The coding agent that works on a copy of your project.</h3>

<p align="center">
  Your files don't change while it works, so it never has to stop and ask for permission.<br>
  When it's done, you see exactly what it changed and what it ran, then apply it or throw it away.
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

Start `revcode` in a git project and it copies the project into a private workspace (a *universe*) and works there. The copy has your git history too, so `git log` and `git diff` work as usual.

1. **It works without interruptions.** It edits files and runs commands on the copy, so there is nothing to approve. It still asks before anything that reaches outside the copy, like `git push`, deploying or `sudo`. Every edit is saved as a checkpoint.
2. **It shows what it did.** Each answer ends with the commands that actually ran and their results, the files that changed, and whether the tests ran after the last edit.
3. **You decide what happens.** `/land` applies the changes to your project, merging with anything you edited in the meantime. `/rewind 3` goes back to checkpoint 3. `/discard` throws everything away. If you quit with changes still in the copy, RevCode asks what to do with them.

Outside a git project, or with `--no-universe`, RevCode works in the folder directly and asks before each change, like other agents.

## Race

<p align="center"><img src="docs/assets/race.svg" alt="revcode race: three attempts fix a failing test at the same time, each in its own copy; all pass npm test, two wrote the same code, and the best one is applied." width="860"></p>

`revcode race "fix the failing test"` runs three attempts at once, each in its own copy. Your tests check every result, the best one is picked, and you choose whether to apply it. If a model gets a task right two times out of three, one of three tries almost always does, and three tries on a cheap model usually cost less than one on a frontier model. Race different models with `--models glm-5.2,anthropic:claude-sonnet-5-5`; cap the whole race with `--max-cost 1`.

## Features

- **Undo any step.** Go back to any checkpoint, files and conversation together, or branch off from one and try a different approach.
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
