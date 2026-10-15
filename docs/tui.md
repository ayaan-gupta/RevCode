# The terminal UI

RevCode's interface is *inline*: it never takes over the screen. Your conversation is ordinary terminal output (so scrollback, selection, search, `tmux` copy-mode and screen readers all work), and a small **live block** is redrawn at the bottom:

```
  ⠹ Cooking…  12s · ↓ 1.2k tokens · esc to interrupt     ← activity (only while working)
  ⏎ then add a test                                        ← messages queued while it works
────────────────────────────────────────────────────────
❯ Ask RevCode…                                             ← the prompt (multi-line, grows)
────────────────────────────────────────────────────────
  /model [name]   Show or switch the model                 ← completion menu
ask before changes          …/proj (main) · glm-5.2 · 12% ctx   ← status line
```

While a permission prompt is open it replaces the prompt in that same block.

## Terminal support

| Capability | Where it works | Fallback |
| --- | --- | --- |
| Truecolor | `COLORTERM=truecolor`, iTerm2, kitty, WezTerm, Ghostty, Windows Terminal, VS Code | 256 colors (macOS Terminal.app), 16 colors, then none |
| Shift+Enter newline | terminals with the kitty keyboard protocol or xterm `modifyOtherKeys` (iTerm2, Ghostty, WezTerm, kitty, foot, Windows Terminal) | **Ctrl+J**, or `\` + Enter |
| Bracketed paste | virtually all modern terminals | multi-line text arriving in one read is still detected as a paste |
| Focus reporting | most modern terminals, tmux with `focus-events on` | bell is rung regardless of focus |
| Hyperlinks (OSC 8) | iTerm2, WezTerm, kitty, Ghostty, VS Code, Windows Terminal, VTE ≥ 0.50 | link text followed by the URL |
| Synchronized output | kitty, WezTerm, iTerm2, Windows Terminal, foot, recent tmux | ignored (a tiny flicker is possible) |
| Unicode glyphs | everything except the Linux console and `TERM=dumb` | ASCII (`>`, `-`, `*`) |

**tmux:** for full color add `set -ga terminal-overrides ",*256col*:Tc"` and for Shift+Enter `set -g extended-keys on`. **macOS Terminal.app** has no truecolor and cannot send Shift+Enter; RevCode detects that and uses 256 colors.

### Environment switches

| Variable | Effect |
| --- | --- |
| `NO_COLOR=1` / `FORCE_COLOR=0..3` | disable color / force a depth |
| `REVCODE_THEME=dark\|light` or `--theme` / `/theme` | force a theme (otherwise `COLORFGBG` is consulted) |
| `REVCODE_ASCII=1` | ASCII glyphs and box drawing |
| `REVCODE_PLAIN_UI=1` | line-based UI even on a TTY (screen readers, odd terminals) |
| `REVCODE_REDUCE_MOTION=1` | repaint the spinner once a second |
| `REVCODE_HYPERLINKS=0\|1` | force OSC 8 hyperlinks off/on |
| `REVCODE_NO_SYNC=1` | do not use synchronized-output markers |

A fault inside the UI never takes the session down: it is logged to `~/.revcode/tui-errors.log` and the session carries on. Report it with the log attached.

## How it is built

Each layer is small, dependency-free, and testable on its own (`src/tui/`):

| Module | Responsibility |
| --- | --- |
| `width.ts` | display width (wide/emoji/combining), ANSI-aware truncate and word-wrap, SGR + hyperlink state carried across wrapped rows |
| `style.ts` | capability detection, color-depth downgrade, light/dark palettes, glyph sets |
| `keys.ts` | raw stdin → key events: CSI/SS3, kitty `CSI u`, modifyOtherKeys, bracketed paste, focus, terminal replies |
| `layout.ts`, `editor.ts` | soft-wrap layout; the prompt editor as a pure state machine (history, undo, kill ring, paste placeholders, search, completion menu) |
| `completion.ts`, `history.ts` | `/` and `@` completion with fuzzy ranking over a git-aware file index; per-project persistent history |
| `screen.ts` | the live region: one atomic write per update, relative cursor moves only, frame rows always narrower than the terminal |
| `frame.ts`, `ui.ts` | pure view-model → rows; the controller that owns stdin, queues messages, runs modals, handles resize/suspend/focus, and routes stray `console` output safely |
| `markdown.ts`, `highlight.ts`, `diff-view.ts`, `tool-view.ts` | content rendering, including row-by-row streaming of long paragraphs |
| `render.ts`, `approval.ts` | the transcript's look (spacing, indentation, cards) and the permission prompt |

### Testing it

- Unit tests cover every layer. `src/testing/mini-terminal.ts` is a tiny terminal emulator (cursor movement, erase, autowrap, scrolling) that replays what the UI writes and returns what a user would see — that is how redraw bugs (ghost frames, wrong row counts after resize) are pinned down.
- `scripts/tui/` drives the *real* program in a pty against a scripted mock model and renders PNG screenshots:

  ```bash
  pip install pyte pillow
  node scripts/tui/mock-server.mjs 8799 &
  python3 scripts/tui/demo.py /tmp/tui-shots
  ```
