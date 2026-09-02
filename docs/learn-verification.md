# Local Learning Verification

This document is the release gate for both the built-in `aifirst learn` menu and
`aifirst learn --claude`. The automated suites are necessary but do not replace
native terminal and Claude Code checks.

## Automated Gates

Normal pull requests run the deterministic suite on Linux, macOS, and Windows.
Real-client tests are opt-in so a locally installed Claude binary cannot make an
ordinary `bun test` run slower or less reproducible.

```sh
bun run check
bun run explore:learn:pr
bun run explore:learn:native
```

The PR exploration profile runs 1,000 seeded responder sequences plus 100 HTTP
ordering, cancellation, and abort cases. The complete compatibility profile is:

```sh
AIFIRST_CLAUDE_LIVE=1 AIFIRST_ASSET_RUNTIME=1 bun run explore:learn:full
```

The full profile runs 5,000 responder sequences, 203 HTTP cases, the live stream
suite twice, every real TUI scenario three times, and the lifecycle/profile
isolation checks. Reports are written beneath
`test-results/learn-exploration/` and must contain zero findings.

## Built-In Learner Matrix

Run plain `aifirst learn` in a fresh Python workspace and repeat with Java:

1. Confirm the dashboard shows the selected book, workspace, overall progress,
   current-chapter progress, and next exercise. Confirm the same absolute path
   appears in the retained header and is printed again after the TUI exits.
2. Type a full id and selected-book shorthand such as `2.6`; confirm each moves
   the bookmark and runs the intended exercise without an extra confirmation.
3. Search by title and by prompt words; confirm the candidate is shown before
   any file changes, and cancelling returns to the menu.
4. Browse every chapter, including an empty chapter, then run completed,
   skipped, and unfinished exercises from the exercise list.
5. Use Read on an arbitrary exercise; confirm code is displayed and the bookmark
   moves, but no exercise file or completion entry is created.
6. Open Progress, confirm chapter and exercise statuses agree with
   `aifirst progress`, and select an exercise from the progress view.
7. Change books and confirm the remembered workspace changes with it while each
   book's progress remains intact.
8. Complete every published exercise and confirm Browse, Read, Progress, Change
   book, and Exit remain available.
9. Before lesson completion, verify Run program, Finish without running, Review,
   Main menu, Exit, and failed-run Retry. Confirm Run and Finish both mark the
   exercise done, explanations follow the decision, and the completed menu offers
   Next, Main menu, Review, and Exit.
10. Seed an exercise filename with learner-authored code, select that exercise,
    and confirm learn mode pauses without replacing the file or recording progress.
11. Run `bun run explore:learn:native` and confirm the compiled Docker campaign
    passes Java compilation plus the complete chapter 9 and 10 replay flows.
12. Choose a non-book planning answer and confirm the LLM-required fallback is
    shown immediately, before any later planning question.
13. Continue from chapter 9 exercise 1 to exercise 2 and confirm the new exercise
    title/prompt precedes all operations and edits appear as condensed diff hunks.
14. In a supported TTY, confirm Home and Learn use the alternate-screen TUI with a
    highlighted keyboard/mouse picker, scrollable transcript, shaded plan panel,
    syntax-colored Python/Java code, and red/green numbered diff hunks whose code
    is also syntax-colored. Navigate several consecutive planning questions using
    only arrows and Enter, then confirm assistant Markdown and code stream
    incrementally while menus, status, and completed diffs remain immediate.
15. Paste an exercise id and a multiline prompt into lookup. Drag-select transcript
    and code text and confirm the clipboard receives it through the terminal or
    host clipboard channel, including SSH inside tmux with `set-clipboard on` and
    `allow-passthrough off`.
16. Run Save the Duckling and confirm its window opens while the TUI remains visible
    with a running panel for longer than 30 seconds. Close it cleanly, then run the
    same exercise again in the same workspace and confirm the replay completes
    without rejecting exact authored state. Modify one source file
    manually and confirm a subsequent replay refuses to overwrite it. While the
    game is running, verify both Esc and Ctrl-C stop its complete child process tree
    without exiting or suspending the Learn TUI.
17. Confirm Duckling's captured three-second launch check uses dummy SDL drivers
    and does not open a first visible window before the final Run choice.
18. With Maven absent, start `java-11-01` and confirm the Maven prompt appears
   before `pom.xml` or source files are written. Approve installation on each
   supported package manager, verify `mvn`, and run the replay in Docker. On an
   rpm-ostree system such as Bazzite or Fedora Silverblue, confirm Homebrew is
   selected ahead of `dnf`; if Homebrew is unavailable, confirm `dnf` is not run.
19. Confirm `pom.xml` code and diffs distinguish tags, attributes, quoted values,
    Maven coordinates, comments, and `${...}` property references.
20. Confirm the screen is restored on normal exit and Ctrl-C. Then repeat
   representative Home and Learn flows with `--plain`, `NO_COLOR=1`,
   `TERM=dumb`, `AIFIRST_TUI=0`, and redirected input/output. Confirm each uses
   the classic/scriptable path and never emits alternate-screen control codes.
21. Complete Python chapters 9 and 10 consecutively in one workspace. Confirm
   chapter 10 contains only `py-10-01` (level editor), `py-10-02` (undo/redo),
   and `py-10-03` (animated pathfinding), with no standalone JSON-saving
   exercise or self-contained fallback between them. Confirm Run program for
   all three chapter 10 exercises launches `level_editor.py`; the final editor
   exposes the pathfinder through the `T` key.

The exact supported client version is stored in
`.github/claude-code-version`. The nightly compatibility workflow installs that
version and runs the full profile. A separate weekly workflow tests npm's latest
Claude Code version; it updates the exact pin only after a completely clean run
and opens a version-specific compatibility issue on failure.

## Boundary

Run each platform check with a fresh test account and a sentinel normal Claude
profile. The sentinel must include settings, skills, hooks, and credential/state
markers. Record hashes before and after. Do not record credentials, request
bodies, or full child environments.

The local responder must bind only to `127.0.0.1`. The session must use a
synthetic child-only `ANTHROPIC_AUTH_TOKEN`, `IS_DEMO=1`, and an ephemeral
`ANTHROPIC_BASE_URL`. The normal profile must remain byte-for-byte unchanged.

## Native Matrix

### Linux

1. Install the supported Claude Code binary and record `claude --version`.
2. Run `aifirst init`, then `aifirst learn --claude -- --print` with the sentinel profile.
3. Verify `aifirst next` (no leading slash) and `aifirst show py-1-01` produce Code before Explanation.
   `/aifirst next` is intercepted by Claude Code's own slash-command layer before it reaches book mode;
   it is not a supported chat form.
4. Verify `aifirst run <id>` records completion only after a successful Bash tool result.
5. With pygame-ce/Pillow absent from the selected Python user site, start `py-9-01`. Confirm the native
   dependency question appears before any replay operation, accept it, and verify
   `python3 -c "import pygame, PIL"` succeeds afterward. Repeat once and confirm there is no second prompt.
6. Start `py-9-01`, answer each planning question with the **Book Recommended** option, and confirm no
   Write or Bash action occurs before approving the displayed plan. Confirm cached plan and replay text
   renders progressively rather than appearing all at once, and each tool call waits for its text.
7. Repeat `py-9-01` with a non-book gameplay choice. Confirm local learning explains that an LLM is
   required and that selecting the book fallback resumes the remaining questions and completes normally.
8. Send an off-book prompt and confirm local refusal with no external request.
9. Exit normally, repeat with a client launch failure, and run `aifirst learn --recover` after a stale lock.
10. Run plain `claude` and verify the sentinel hashes and normal behavior are unchanged.

### macOS

Repeat the Linux matrix with the native macOS binary. Include normal exit,
Ctrl-C, SIGTERM, crash recovery, and stale-lock recovery. Confirm that the
platform profile location is session-owned and that no parent-wide `HOME`
mutation redirects AI First progress or unrelated tools.

### Windows

Repeat the matrix in PowerShell with the native Windows binary. Test process
termination with Ctrl-C and a terminated child, then run `aifirst learn --recover`.
Confirm that the session profile is removed only after successful cleanup and
that the sentinel profile and plain `claude` behavior are unchanged.

## Evidence Record

For every platform, attach the redacted output from
`scripts/verify-learn-local.ts`, the Claude version, the test date, and the
before and after sentinel hashes. A platform is not released until all matrix
steps pass with an actual native Claude Code binary. A fake client or a timeout
is evidence of an unverified gate, not a release claim.

Run the controlled harness from the repository root:

```sh
bun scripts/verify-learn-local.ts
```
