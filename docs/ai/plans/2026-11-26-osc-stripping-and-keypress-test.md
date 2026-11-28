---
feature_id: osc-stripping-and-keypress-test
date: 2026-11-26
kind: decision-note
shipped: false
---

# Decision note: stop OSC sequences from swallowing visible text

This is a decision note written after implementation. It is not a verbatim copy
of the approved plan. It records what was decided, why, and the evidence that
was observed.

Fix commit: `9c73362` (`fix: stop OSC sequences from swallowing visible text`)
on `fix/tui-test-reliability`, based on `release/v0.13.2` at `02a1873`.

## Problem

After the macOS streaming failures on #26, local runs of the base still failed
two streaming tests on every attempt: "reveals the read-only prompt on a
keypress and still requires Enter" and "streams incrementally and does not leak
Enter into the following picker". PR #27 had already fixed the mouse click and
plan reveal tests by waiting for the reveal footer, holding the stream, and
allowing unordered markers. Its note recorded that the full local check still
had four failures.

## Cause

1. **The keypress test matched streamed text.** It waited for `Builda`. The
   prompt is drawn with a typing cursor (`▌`) after the last character, and with
   per-cell redraws the capture reads `B▌u▌i▌l▌d▌ a▌`, so the marker never
   appears as one string. #27 fixed the same problem in the click test.
2. **The ANSI pattern let an OSC run too far.** The OSC alternative
   `\][^\x07]*(?:\x07|\x1b\\)` let an OSC that ends with ESC-backslash, such as
   OpenTUI's `\x1b]66;` capability probe or an OSC 8 hyperlink, run on to a
   later BEL or the last ESC-backslash in the text. Everything in between was
   removed. In "streams incrementally" the cleaned output was empty, so its
   expected sentence was never found.

The same pattern was in `src/tui/session.ts`. Its `stripAnsi` cleans the
embedded program output panel, titles and labels in Learn, so a program that
printed an OSC 8 link lost the link's label there.

## Decisions

- **One rule everywhere.** An OSC now ends at its first BEL or ESC-backslash:
  `\][\s\S]*?(?:\x07|\x1b\\)`. The change is the same single token in all 11
  copies: `src/tui/session.ts`, `test/tui-streaming.test.ts`,
  `test/learn-confirmation-live.test.ts`, the six PTY drivers under
  `test/fixtures/`, and both `scripts/explore-*.ts`. Fixing only the failing
  tests would have left the product bug and the other drivers inconsistent.
- **Reuse #27's pattern for the keypress test.** It now waits for "Press any
  key or click to show the full prompt" and runs the fixture with
  `--hold-stream`, so the key press, not the animation timer, reveals the
  prompt. No retries or longer timeouts were added.
- **No change to how the driver matches cursor-drawn text.** An earlier
  candidate stripped `▌` inside the driver and reordered the plan test. #27
  had already solved those cases a different way, so they were dropped.
- **Scope.** A separate PR against `release/v0.13.2`, the only line that has
  these tests. No version bump or release.

## Tests

- `test/tui-strip-ansi.test.ts`: `stripAnsi` keeps the label of an OSC 8 link,
  keeps text between an ESC-backslash OSC and a later BEL, and still removes
  BEL-ended OSC, CSI and SGR sequences. `stripAnsi` is exported for this test.
- `test/tui-driver-matching.test.ts` with `test/fixtures/tui-osc-marker-program.ts`:
  the PTY driver must find a marker written between two OSC sequences, with
  the second ending in either ESC-backslash or BEL. The fixture writes fixed
  bytes, so the test does not depend on timing.

## Evidence

All results below were observed on Linux. Exit statuses are the commands' own.

| Run | Exit | Result |
| --- | --- | --- |
| Baseline `bun run check` at `02a1873` | 1 | 582 pass, 34 skip, 5 fail |
| Red: new tests and `tui-streaming.test.ts` | 1 | 7 fail: both driver cases timed out waiting for the marker, keypress stuck on `Builda`, streams incrementally saw an empty string, and the 3 `stripAnsi` tests |
| Green: same tests | 0 | 14 pass |
| `bun run typecheck` | 0 | |
| `bun run check` after | 1 | 589 pass, 34 skip, 3 fail |

| Test, 20 isolated runs each | Before | After |
| --- | --- | --- |
| keypress | 0/20 | 20/20 |
| streams incrementally | 0/20 | 20/20 |
| mouse click | not run | 20/20 |
| plan reveal | not run | 20/20 |

The full check also stopped failing "lets the reader answer an input exercise
inside the TUI". Two environment-dependent failures remain, as before: one
session test that rejects `.claude` in `PATH`, and one syntax color test that
expects 256-color output.

The other five drivers, `learn-confirmation-live.test.ts` and the two
exploration scripts need a live Claude session. They were checked by compiling
or type checking only, not run.

## Open point

One full check failed "lets a terminal reader answer an interactive exercise"
in `test/run.test.ts` with 2 of 3 driver actions completed, although the output
contained the last marker. The test passed 20 of 20 isolated runs both with and
without this change. The driver evaluates one action per loop pass and stops as
soon as the child exits, so a final marker that arrives with the exit can go
unchecked. That loop is unchanged by this fix; checking the remaining wait-only
actions against the captured output before stopping would close it.

Hosted macOS CI on the PR is the cross-platform check.
