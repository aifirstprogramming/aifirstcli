---
feature_id: learn-session-path-isolation
date: 2026-11-28
kind: decision-note
shipped: false
---

# Decision note: keep the learner's ~/.claude off the Learn session PATH

This is a decision note written after implementation, not a verbatim plan.

## Problem

Two tests failed only on a developer machine running inside Claude Code:

- "local Claude session > uses a session-owned normal profile and TUI"
  asserts that no value in the isolated session's environment contains
  `.claude`. Claude Code adds plugin `bin` folders under `~/.claude` to
  `PATH`, and `claudeLaunch` copied `PATH` unchanged.
- "rendered OpenTUI syntax colors > applies semantic colors to code and diff
  renderables" expects 256-color background codes. The terminal set
  `COLORTERM=truecolor`, which the test passed to its child, so OpenTUI drew
  truecolor backgrounds instead.

CI sets neither, so both passed there.

## Decisions

- **The PATH failure is a product gap, so the product changes.** `claudeLaunch`
  in `src/learn/session.ts` exists to start Claude without the learner's own
  Claude state. Passing plugin `bin` folders from `~/.claude` would let the
  isolated session run the learner's plugins. `PATH` entries that are
  `~/.claude` or inside it are now dropped. Look-alike folders such as
  `~/.claude-other` are kept, and the comparison ignores case on Windows.
- **Launching Claude is unaffected.** Learn resolves `claude` to an absolute
  path before it starts the session, so the child does not need these
  entries to find it.
- **The color failure is a test assumption, so the test changes.** The test
  now drops `COLORTERM` from the environment it gives the rendered program,
  so it always runs in the 256-color mode its assertions describe. No
  product behavior changed for color.
- **Scope.** Landed on `main`. The release line can take the `PATH` change in
  a later patch release.

## Evidence

Observed on Linux, inside Claude Code with `COLORTERM=truecolor`:

| Run | Exit | Result |
| --- | --- | --- |
| New `PATH` test before the fix | 1 | Fails: the two `~/.claude` entries were returned |
| Color test with `COLORTERM=truecolor`, before | 1 | 4 pass, 1 fail |
| Color test with `COLORTERM` unset, before | 0 | 5 pass |
| Both test files after the fix | 0 | 16 pass |
| `bun run typecheck` | 0 | |
| `bun run check` after the fix | 0 | 597 pass, 34 skip, 0 fail |

The full local check had carried these two failures through every earlier
change on this line; this is the first local run with none.
