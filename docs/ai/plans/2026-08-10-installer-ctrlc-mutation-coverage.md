<!-- Captured from a Hermes Agent session. Fresh authorship for this file: no prior AI session transcript exists to capture for this follow-up. -->

> **AI development artifact, implementation plan.**
> This is the plan the agent worked from for this fix, written at the time the work happened. It
> records the root cause, what was verified rather than assumed, the decisions and their
> alternatives, and how the result was checked.
>
> | | |
> | --- | --- |
> | **Feature** | installer-ctrlc-mutation-coverage |
> | **Date** | 2026-08-10 |
> | **Outcome** | **Shipped** |

---

# Close a mutation-coverage gap in the Ctrl-C fix's test suite

## Context

The installer-ctrlc-runaway fix (`46e09b3`, `f8d2ff4`, `94408df`) added three coordinated
mechanisms to `download_with_progress()`'s signal path in `install/install.sh`: an explicit
`kill "$DL_PID"` inside `cleanup()`, a re-raise of SIGINT after cleanup (`trap 'cleanup; trap -
INT; kill -INT $$' INT`), and a defensive loop-break on a deleted destination file. A follow-up
review found that two of the twelve tests already covering this code, despite being named for
these exact mechanisms, do not actually catch a mutation that deletes either one. The fix itself
is correct; the gap is in what the tests prove.

## What I verified rather than assumed

- Confirmed on the tracked `install/install.sh` at HEAD (`94408df`) that a direct function call
  to `cleanup()` (source the extracted function, background `sleep 30` as `DL_PID`, call
  `cleanup` with no trap and no signal involved) kills the child. With the `kill "$DL_PID"` line
  removed, the same test leaves the child alive. This isolates the kill line from any tty/signal
  channel entirely, since nothing in that test can touch the child except the line under test.
- Built a `subprocess.Popen`-based SIGINT driver with no pty anywhere in its call chain and
  confirmed with `ps -o tty=` that the resulting process tree shows `?` for its controlling
  terminal, i.e. genuinely no tty. Against the real code, sending `SIGINT` to that process
  produces a negative return code (Python's signal-terminated convention); with the INT trap
  reduced to plain `trap 'cleanup' INT`, the same process exits with a plain positive code
  instead.
- I initially tried a plain `sh script &` shell-backgrounding approach for the second test and it
  produced a false negative: a script backgrounded with the shell's own `&` operator running
  under a non-interactive parent inherits `SIG_IGN` for `SIGINT` from job-control semantics, and
  `trap - INT` restores that inherited disposition rather than `SIG_DFL`, so the re-raise
  silently no-ops even against the real, unmutated code. Switching the driver to
  `subprocess.Popen` (which does not go through the shell's job-control path) fixed this. This
  matches, but is a distinct failure mode from, the pty-fanout masking the spec's Context section
  describes for the existing suite; it's worth recording so the next person doesn't reintroduce
  it by reaching for `&` as a quick no-pty way to background the runner.
- Ran the full self-verification pass required by the card: applied each mutation in place against
  the tracked `install/install.sh`, ran the full suite, confirmed only the new test for that
  mechanism failed while the eleven others passed, then reverted with `git checkout --` and
  confirmed all fourteen tests passed again. Transcripts below.
- Confirmed `git diff 94408df..HEAD -- install/install.sh` is empty at handoff. No change to the
  installer's actual signal/cleanup logic; this is a test-only addition.
- Ran `shellcheck --shell=sh` on both `install.sh` and the extended test file. The only warning is
  a pre-existing `SC2034` on line 261 (unrelated to this change, present before I touched the
  file); my added `TMP` assignment in the new MUT1 test triggers the same class of warning because
  shellcheck can't see it's consumed after `. "$CLEANUP_LIB"`, so I added an inline
  `shellcheck disable=SC2034` with a one-line reason rather than restructuring working test code.
- Ran `bun install --frozen-lockfile && bun run check` (223/223 tests pass, matching the parent
  feature's baseline) and `bun scripts/build.ts --local && ./bin/aifirst-linux-x64 --version`
  (prints `0.6.0`).

## Decision

Extended the existing `install/test-download-progress.sh` (rather than splitting into a sibling
file) with two new cases, both isolated from the tty/pty channel:

1. **`cleanup_kills_backgrounded_downloader_direct_invocation`** (MUT1 guard): source the
   extracted `cleanup()`, background a real `sleep 30` as `DL_PID`, call `cleanup` as a plain
   function call, assert the child is dead via `kill -0`. No pty, no trap, no signal delivery of
   any kind.
2. **`sigint_without_pty_produces_signal_terminated_exit`** (MUT3 guard): a new fixture,
   `install/fixtures/kill_int_no_pty_driver.py`, launches the runner via `subprocess.Popen` (no
   pty, no shell backgrounding) and sends `SIGINT` directly to its pid, asserting the exit is
   signal-terminated.

Chose to extend the existing file over a new sibling because the two new cases share the same
`CLEANUP_LIB` extraction, `INT_TRAP_LINE`/`EXIT_TRAP_LINE` extraction, and `WORK` scratch
directory already set up earlier in the file; duplicating that setup in a second file would have
been the actual scope creep.

Chose `subprocess.Popen` over a second `pty.fork()`-based driver for MUT3 specifically because the
existing `pty_sigint_driver.py` is what masks the mutation in the first eleven tests; reusing pty
machinery for the new test would risk reintroducing the exact confound this follow-up exists to
remove. Verified with `ps -o tty=` that the new driver's process tree has no controlling terminal.

Left the twelve pre-existing tests, including the two whose names already claimed to guard these
mechanisms, completely unmodified. They remain valid regression coverage for the real-world pty
reproduction path (acceptance criteria 1/4/5 of the original fix); this follow-up is additive.

## Verification added

Full suite after the additions, real code, both new tests passing alongside the twelve existing
ones:

```
ok   redirect_follows_and_downloads_full_bytes (1049353 bytes)
ok   progress_shows_intermediate_values (5 distinct mid-range percentages)
ok   non_tty_output_has_no_carriage_returns
ok   corrupted_download_rejected (checksum mismatch correctly detected)
ok   http_404_still_fails (non-zero exit, empty file)
ok   sigint_during_curl_download_exits_promptly_no_spam (elapsed=1.34 signaled=True signal=2 exit=-1)
ok   sigint_during_curl_download_exits_promptly_no_spam (no orphaned curl)
ok   sigint_during_wget_download_exits_promptly_no_spam (elapsed=1.01 signaled=True signal=2 exit=-1)
ok   sigint_during_wget_download_exits_promptly_no_spam (no orphaned wget)
ok   single_sigint_is_sufficient (elapsed=1.39 signaled=True signal=2 exit=-1, one \x03 sent)
ok   dest_file_deleted_mid_transfer_breaks_loop (no timeout, no spam)
ok   double_sigint_does_not_double_cleanup_error (elapsed=1.34 signaled=True signal=2 exit=-1)
ok   cleanup_kills_backgrounded_downloader_direct_invocation
ok   sigint_without_pty_produces_signal_terminated_exit (signaled=True signal=2 exit=-1)
all download_with_progress regression tests passed
```

**MUT1 self-verification** (delete `[ -n "${DL_PID:-}" ] && kill "$DL_PID" 2>/dev/null` from
`cleanup()` in the tracked `install/install.sh`, run the suite, revert):

Mutated run, eleven pre-existing tests still green, new test correctly fails:
```
ok   sigint_during_curl_download_exits_promptly_no_spam (elapsed=1.35 signaled=True signal=2 exit=-1)
ok   sigint_during_curl_download_exits_promptly_no_spam (no orphaned curl)
ok   sigint_during_wget_download_exits_promptly_no_spam (elapsed=11.22 signaled=True signal=2 exit=-1)
ok   sigint_during_wget_download_exits_promptly_no_spam (no orphaned wget)
ok   single_sigint_is_sufficient (elapsed=1.34 signaled=True signal=2 exit=-1, one \x03 sent)
ok   dest_file_deleted_mid_transfer_breaks_loop (no timeout, no spam)
ok   double_sigint_does_not_double_cleanup_error (elapsed=1.34 signaled=True signal=2 exit=-1)
FAIL cleanup_kills_backgrounded_downloader_direct_invocation: child 7627 still alive after direct cleanup() call
ok   sigint_without_pty_produces_signal_terminated_exit (signaled=True signal=2 exit=-1)
one or more download_with_progress regression tests FAILED
```

Reverted (`git checkout -- install/install.sh`), same test passes again:
```
ok   cleanup_kills_backgrounded_downloader_direct_invocation
ok   sigint_without_pty_produces_signal_terminated_exit (signaled=True signal=2 exit=-1)
all download_with_progress regression tests passed
```

**MUT3 self-verification** (replace `trap 'cleanup; trap - INT; kill -INT $$' INT` with plain
`trap 'cleanup' INT`, run the suite, revert):

Mutated run, eleven pre-existing tests still green (including the pty-driven ones, since the pty's
own terminal-generated SIGINT still kills the foreground process group regardless of the trap),
new test correctly fails:
```
ok   sigint_during_curl_download_exits_promptly_no_spam (elapsed=1.35 signaled=True signal=2 exit=-1)
ok   sigint_during_curl_download_exits_promptly_no_spam (no orphaned curl)
ok   sigint_during_wget_download_exits_promptly_no_spam (elapsed=1.01 signaled=True signal=2 exit=-1)
ok   sigint_during_wget_download_exits_promptly_no_spam (no orphaned wget)
ok   single_sigint_is_sufficient (elapsed=1.39 signaled=True signal=2 exit=-1, one \x03 sent)
ok   dest_file_deleted_mid_transfer_breaks_loop (no timeout, no spam)
ok   double_sigint_does_not_double_cleanup_error (elapsed=1.34 signaled=True signal=2 exit=-1)
ok   cleanup_kills_backgrounded_downloader_direct_invocation
FAIL sigint_without_pty_produces_signal_terminated_exit: signaled=False signal=0 exit=1
one or more download_with_progress regression tests FAILED
```

Reverted, same test passes again:
```
ok   cleanup_kills_backgrounded_downloader_direct_invocation
ok   sigint_without_pty_produces_signal_terminated_exit (signaled=True signal=2 exit=-1)
all download_with_progress regression tests passed
```

CI gate, unrelated to the mutation-testing pass but required by acceptance criterion 4:

```
bun install v1.3.14: Checked 6 installs across 7 packages (no changes)
bun run check: 223 pass, 0 fail, 493 expect() calls across 15 files
shellcheck --shell=sh install/install.sh install/test-download-progress.sh: one pre-existing
  SC2034 warning on line 261, unchanged from before this change
bun scripts/build.ts --local: aifirst-linux-x64 built, 92.1 MB
./bin/aifirst-linux-x64 --version: 0.6.0
```

## Rework: test 11 was shadowing the harness's own cleanup()

The independent-verifier rejected the first attempt. Test 11 did `. "$CLEANUP_LIB"` at the top
level of `install/test-download-progress.sh`, which redefines `cleanup()` in the whole script's
function table, not just for that test. That permanently replaces the harness's own `cleanup()`
(the one the file's own `trap cleanup EXIT INT TERM` depends on to kill fixture-server PIDs and
remove the scratch `WORK` dir) with `install.sh`'s `cleanup()` for the rest of the script's
lifetime. Two effects followed: fixture HTTP servers on ports 8551-8560 leaked past every run
because the swapped-in `cleanup()` doesn't know about `$PIDS`, and the script's own exit code
came from the swapped-in `cleanup()`'s return value instead of the trap's real intent, producing
exit 1 on a run where every individual test printed `ok`.

**Fix:** moved test 11's body into a `$(...)` subshell. Sourcing `$CLEANUP_LIB` inside a subshell
only redefines `cleanup()` in that subshell's own function table; the parent script (and its
`trap cleanup EXIT INT TERM`) never sees the substitution. The subshell communicates its result
back to the parent via stdout (`echo dead` or `echo "still-alive $DL_PID"`), which the parent
then asserts on with a `case` statement.

### What I verified for the rework (freshly run, not carried forward)

Clean full run, twice in a row on a freshly restarted container, confirming no leaked fixture
processes and a correct exit code:

```
ok   redirect_follows_and_downloads_full_bytes (1049353 bytes)
ok   progress_shows_intermediate_values (5 distinct mid-range percentages)
ok   non_tty_output_has_no_carriage_returns
ok   corrupted_download_rejected (checksum mismatch correctly detected)
ok   http_404_still_fails (non-zero exit, empty file)
ok   sigint_during_curl_download_exits_promptly_no_spam (elapsed=1.34 signaled=True signal=2 exit=-1)
ok   sigint_during_curl_download_exits_promptly_no_spam (no orphaned curl)
ok   sigint_during_wget_download_exits_promptly_no_spam (elapsed=1.01 signaled=True signal=2 exit=-1)
ok   sigint_during_wget_download_exits_promptly_no_spam (no orphaned wget)
ok   single_sigint_is_sufficient (elapsed=1.39 signaled=True signal=2 exit=-1, one \x03 sent)
ok   dest_file_deleted_mid_transfer_breaks_loop (no timeout, no spam)
ok   double_sigint_does_not_double_cleanup_error (elapsed=1.34 signaled=True signal=2 exit=-1)
ok   cleanup_kills_backgrounded_downloader_direct_invocation
ok   sigint_without_pty_produces_signal_terminated_exit (signaled=True signal=2 exit=-1)
all download_with_progress regression tests passed
```

`echo $?` reported `0` on both runs. `pgrep -fa python3` / `pgrep -fa curl` / `pgrep -fa wget`
immediately after each run returned nothing (only the `pgrep` invocation itself, which always
matches its own command line).

**MUT1 self-verification, re-run against the fixed test file** (delete
`[ -n "${DL_PID:-}" ] && kill "$DL_PID" 2>/dev/null` from `cleanup()` in the tracked
`install/install.sh`, run the suite, revert):

Mutated run, new test correctly fails, everything else still green, overall exit code correctly 1:
```
ok   redirect_follows_and_downloads_full_bytes (1049353 bytes)
ok   progress_shows_intermediate_values (5 distinct mid-range percentages)
ok   non_tty_output_has_no_carriage_returns
ok   corrupted_download_rejected (checksum mismatch correctly detected)
ok   http_404_still_fails (non-zero exit, empty file)
ok   sigint_during_curl_download_exits_promptly_no_spam (elapsed=1.35 signaled=True signal=2 exit=-1)
ok   sigint_during_curl_download_exits_promptly_no_spam (no orphaned curl)
ok   sigint_during_wget_download_exits_promptly_no_spam (elapsed=1.01 signaled=True signal=2 exit=-1)
ok   sigint_during_wget_download_exits_promptly_no_spam (no orphaned wget)
ok   single_sigint_is_sufficient (elapsed=1.01 signaled=True signal=2 exit=-1, one \x03 sent)
ok   dest_file_deleted_mid_transfer_breaks_loop (no timeout, no spam)
ok   double_sigint_does_not_double_cleanup_error (elapsed=1.01 signaled=True signal=2 exit=-1)
FAIL cleanup_kills_backgrounded_downloader_direct_invocation: child still-alive 4432 after direct cleanup() call
ok   sigint_without_pty_produces_signal_terminated_exit (signaled=True signal=2 exit=-1)
one or more download_with_progress regression tests FAILED
```
`echo $?` reported `1`. `pgrep` checks immediately after showed no leaked fixture processes.

Reverted (`git checkout -- install/install.sh`), same test passes again:
```
ok   cleanup_kills_backgrounded_downloader_direct_invocation
ok   sigint_without_pty_produces_signal_terminated_exit (signaled=True signal=2 exit=-1)
all download_with_progress regression tests passed
```
`echo $?` reported `0`.

**MUT3 self-verification, re-run against the fixed test file** (replace
`trap 'cleanup; trap - INT; kill -INT $$' INT` with plain `trap 'cleanup' INT`, run the suite,
revert):

Mutated run, new test correctly fails, everything else still green:
```
ok   redirect_follows_and_downloads_full_bytes (1049353 bytes)
ok   progress_shows_intermediate_values (5 distinct mid-range percentages)
ok   non_tty_output_has_no_carriage_returns
ok   corrupted_download_rejected (checksum mismatch correctly detected)
ok   http_404_still_fails (non-zero exit, empty file)
ok   sigint_during_curl_download_exits_promptly_no_spam (elapsed=1.35 signaled=True signal=2 exit=-1)
ok   sigint_during_curl_download_exits_promptly_no_spam (no orphaned curl)
ok   sigint_during_wget_download_exits_promptly_no_spam (elapsed=1.01 signaled=True signal=2 exit=-1)
ok   sigint_during_wget_download_exits_promptly_no_spam (no orphaned wget)
ok   single_sigint_is_sufficient (elapsed=1.39 signaled=True signal=2 exit=-1, one \x03 sent)
ok   dest_file_deleted_mid_transfer_breaks_loop (no timeout, no spam)
ok   double_sigint_does_not_double_cleanup_error (elapsed=1.34 signaled=True signal=2 exit=-1)
ok   cleanup_kills_backgrounded_downloader_direct_invocation
FAIL sigint_without_pty_produces_signal_terminated_exit: signaled=False signal=0 exit=1
one or more download_with_progress regression tests FAILED
```
`echo $?` reported `1`. `pgrep` checks immediately after showed no leaked fixture processes.

Reverted, same test passes again:
```
ok   cleanup_kills_backgrounded_downloader_direct_invocation
ok   sigint_without_pty_produces_signal_terminated_exit (signaled=True signal=2 exit=-1)
all download_with_progress regression tests passed
```
`echo $?` reported `0`. `git diff install/install.sh` empty after revert.
