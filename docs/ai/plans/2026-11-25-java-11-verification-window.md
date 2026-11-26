---
feature_id: java-11-verification-window
date: 2026-11-25
kind: decision-note
shipped: false
---

# Decision note: explain the JavaFX wait during Learn verification

This is a decision note written after implementation and review. It is not a
verbatim copy of the approved plan. It records what was decided, why, and the
evidence that was actually observed.

Fix commit: `96e7ad47` (`fix: explain JavaFX wait during verification`) on
`fix/java-11-verification-window`, based on `release/v0.13.2`.

## Problem

A tester reported that Java Chapter 11, Exercise 2 (java-11-02) stayed on
"Running verification / Working..." in `aifirst learn` for several minutes until
they cancelled it. They wondered whether skipping the previous exercise or a
looping model was to blame.

The panel in the report matches v0.13.4, which is commit `1aab407`, the tip of
`release/v0.13.2`. That build was identified by matching the panel shown in the
report, not read from the tester's machine. The "Running verification" panel exists only on that
release line; `main` does not have it.

## Cause

1. java-11-01 and java-11-02 use compact playback. `replaySegments()` in
   `src/bookmode/responder.ts` turns the whole step into one command:
   `aifirst replay execute <id>`.
2. Learn runs that command inside `withTaskRunning("Running verification")` in
   `src/tui/session.ts`, which only shows a spinner and "Working...".
3. `replay execute` runs the step's `replay.operations` in order. For both
   exercises these end with `mvn -q clean test` followed by
   `mvn -q javafx:run`, marked `graphical: true`, with no timeout.
4. `mvn javafx:run` returns only when the reader closes the app window. The
   finished app opens and waits, while the panel keeps saying "Working...", so
   verification looks hung.

The two hypotheses in the report were checked and ruled out:

- **Previous exercise not done.** The java-11-02 replay is made of full file
  writes. `ReplayStateGuard.decide()` executes a write when the file is missing,
  and a conflicting file is rejected immediately, which would be a fast failure,
  not a wait. The regression test below starts from an empty workspace and
  completes.
- **Model looping.** Learn is the built-in offline replay. No model is involved,
  and the command sequence is deterministic.

## Decisions

### Learn tells the reader to close the window

When the operations that `aifirst replay execute` will run include a
`graphical: true` command, and a display is available, the verification panel
gets a second line:

> When the program window opens, close it to return to Learn.

The wording says what to do when the window appears without claiming that it
has already opened, because the tests run first and can take a while. It is
short enough to fit on one line of an 80 column terminal, the size the tester
used. With the detail line present the footer is shortened to "Esc / Ctrl+C
stops this command" for the same reason.

The detection looks only at `replay.operations`, because that is exactly what
`executeReplayAsync` iterates. A graphical command that appears only in narrated
`events` does not trigger the guidance. Headless Linux (no `DISPLAY` and no
`WAYLAND_DISPLAY`) already skips graphical launches in the replay executor, so
it gets no guidance; that check now lives in one shared helper,
`graphicalLaunchSkipped()`. Non-graphical verification is unchanged.

The plain, non-TUI Learn path was deliberately left untouched.

### The app launch stays

Opening the finished application once is authored behavior: the playback phase
for java-11-02 reads "Run the complete test suite and open the finished
application once." Showing the reader their working app is the point of the
capstone step. Detaching the launch, adding a timeout, or skipping it would
change what the book promises, so the fix is guidance only. No book content,
replay semantics, timeouts, or launch behavior changed.

### Scope: the release branch

The fix is based on `release/v0.13.2`, because that is the code the tester ran
and the only place the affected panel exists. Bringing it to `main` is a
separate step, since `main` does not yet contain `1aab407`. This change does
not bump the version or publish a release.

## Tests

- `test/learn-verification-window.test.ts` drives the real `aifirst learn` TUI
  to java-11-02 through a PTY at 80 by 24, with a fake Maven on `PATH`, so no
  JDK, Maven, or display server is needed. It covers:
  - the success path: waits for the guidance, simulates closing the window, and
    checks that the lesson completes and is recorded;
  - Esc and Ctrl+C: a snapshot taken immediately before the key proves that the
    fixture's own fake Maven and the `replay execute` process group were alive,
    and that the replay process was that Maven's parent and group leader; the
    test then checks that both are gone;
  - headless Linux: no window, no guidance, and verification still completes.

  The suite is skipped on Windows, like the other PTY suites. Cleanup signals a
  process group only after proving ownership through the fixture's live fake
  Maven, and never matches on generic arguments alone.
- `test/graphical-run.test.ts` adds unit tests for `verificationTaskOptions()`:
  both PocketCFO exercises, headless Linux, a non-graphical step, a direct
  graphical command, and operations versus events.
- `test/fixtures/native-tui-driver.py` gained `waitFile`, `touch`, and
  `snapshotPids` actions, and now always reaps its PTY child with a blocking
  wait after SIGKILL.

## Evidence

All results below were observed on Linux. Exit statuses are the commands' own,
not a filter's.

| Run | Code | Exit | Result |
| --- | --- | --- | --- |
| Baseline `bun run typecheck` | unfixed `1aab407` | 0 | |
| Baseline `bun run check` | unfixed `1aab407` | 1 | 571 pass, 34 skip, 6 fail |
| Red: new focused tests | unfixed source | 1 | PTY success test reached the graphical stage (3 of 5 driver actions) and then timed out waiting for the guidance; 4 unit tests failed because the helper did not exist |
| Cancel and headless guards | unfixed source | 0 | 3 pass; these guard behavior that already worked |
| Red, repeated with the final test | unfixed source | 1 | Same failure: reached the graphical stage, guidance missing |
| Green: new focused tests | fixed | 0 | 16 pass |
| `bun run check` | fixed | 1 | 579 pass, 34 skip, 6 fail; failure list identical to the baseline |
| Focused tests after review changes | fixed | 0 | 17 pass |
| Other driver-based test files after review changes | fixed | 1 | 53 pass, 4 fail; all 4 are in the baseline list |

The 6 baseline failures are environment-dependent and occur with or without
this change: three TUI streaming tests, one TUI reader-input test, one syntax
color test, and one session-environment test.

After every run, no fake Maven processes or temporary fixture directories were
left behind. The captured screen showed the guidance intact on a single row at
80 columns.

The reviewer independently ran the 17 focused tests and a Linux build and smoke
test.

Not yet verified: a real desktop run with Maven and JavaFX installed, and
macOS CI. Both are expected before release.
