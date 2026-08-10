<!-- Captured from a Hermes Agent session. Fresh authorship for this file: no prior AI session transcript exists to capture for this fix. -->

> **AI development artifact, implementation plan.**
> This is the plan the agent worked from for this fix, written at the time the work happened. It
> records the root cause, what was verified rather than assumed, the decisions and their
> alternatives, and how the result was checked.
>
> | | |
> | --- | --- |
> | **Feature** | installer-ctrlc-runaway |
> | **Date** | 2026-08-10 |
> | **Outcome** | **Shipped** |

---

# Stop the installer leaving an orphaned download after Ctrl-C

## Context

`install/install.sh`'s `download_with_progress()` backgrounds curl or wget with `&` and polls its
size with `kill -0` to drive the progress bar. In a non-interactive shell, bash does not forward
SIGINT to a backgrounded child automatically. Before this fix, pressing Ctrl-C during a download
killed the polling loop's own shell (the `while` reads `$dl_dest` via `wc -c`, and a plain `trap
"rm -rf '$TMP'" EXIT INT TERM` ran `rm -rf` on the temp dir) but left curl or wget itself running
in the background, still writing to a file whose parent directory had just been deleted out from
under it. That produced the repeated "No such file or directory" spam the user reported and left
a real network transfer running to completion in the background with nobody watching it.

## What I verified rather than assumed

- Reproduced the exact symptom with a real pty and a real `\x03`, not `kill -INT`, against the
  unmodified `download_with_progress` sourced verbatim out of `install.sh`. The env-provisioner's
  reproduction harness (`install/fixtures/pty_sigint_driver.py` plus a throttled local HTTP
  server) showed the runaway curl/wget process surviving script exit, matching the card's report.
- Extracted install.sh's actual trap lines into the test harness at run time (`grep` against the
  live file) rather than hardcoding a copy of the trap syntax in the test runner, after an early
  version of the test kept passing against a mutation that broke the trap wiring itself.
- Mutation-tested all three mechanisms independently: reverted the kill+cleanup function back to
  the old bare `trap "rm -rf ..."`, dropped the `trap - INT; kill -INT $$` re-raise, and removed
  the `[ -e "$dl_dest" ] || break` defensive check. Each reversion made the suite fail, either by
  timing out, by an assertion catching the same "cannot open ... No such file" spam the fix
  removes, or (for the first mutation) by leaving no `cleanup()` function for the extraction step
  to find at all.
- Found and fixed a second spam source the mutation testing surfaced: the final progress render
  after the polling loop unconditionally called `wc -c < "$dl_dest"` even when the defensive break
  had just fired because the destination was gone, printing one more "cannot open" line. Guarded
  that call with the same `[ -e "$dl_dest" ]` check.
- Confirmed dash (this container's `/bin/sh`) phrases the missing-file error as "cannot open ...
  No such file", not the GNU "No such file or directory" I'd assumed, and corrected the test's
  grep patterns to match the shell that actually runs them.
- Ran the existing five-case `test-download-progress.sh` suite unchanged (redirect-follow,
  intermediate progress, non-TTY plain lines, checksum rejection, 404 handling) to confirm the fix
  didn't regress the prior redirect fix.
- Did not assume PowerShell parity from the spec's own suspicion. Installed PowerShell 7.6.4 into
  the devcontainer, extracted `Get-Bar` and `Invoke-DownloadWithProgress` verbatim from
  `install.ps1`, and drove a real Ctrl-C through a pty at pwsh downloading from the same throttled
  local server. The `finally` block ran (`FINALLY_RAN` printed), no lingering connection remained
  on the listening port after Ctrl-C, and the process exited cleanly. `Invoke-DownloadWithProgress`
  is a synchronous foreground loop in the same process, so there is no backgrounded child for
  SIGINT to fail to reach and no equivalent of the bash trap-vs-loop race. No code change needed
  in `install.ps1`.

## Decision

Three changes, kept together because each alone leaves a gap:

1. Track the backgrounded downloader's pid in `DL_PID` (already needed for the `kill -0` poll,
   renamed from the old unused-outside-the-function local to a script-scope var the trap can see).
2. Replace the bare `trap "rm -rf '$TMP'" EXIT INT TERM` with a `cleanup()` function that kills
   `$DL_PID` before removing `$TMP`, wired as `trap 'cleanup; trap - INT; kill -INT $$' INT` plus
   `trap cleanup EXIT TERM`. The re-raise after cleanup is not decoration: without it the calling
   shell sees a plain nonzero exit rather than a real SIGINT termination (exit 130), and the spec's
   acceptance criteria explicitly check exit *mode*, not merely a nonzero code.
3. Add `[ -e "$dl_dest" ] || break` to the polling loop (and the equivalent guard on the final
   render) so a destination removed out from under the loop, whether by this same cleanup path or
   by an external actor, stops the loop instead of spinning on read errors.

Considered a single combined `trap cleanup EXIT INT TERM` without the re-raise, since it's shorter.
Rejected because it fails acceptance criterion 4: the shell that ran the installer needs to see a
real signal death to behave correctly in scripts that chain off it (`install.sh && start-app`
should not proceed after a cancelled install, and it won't if the exit looks like an ordinary
failure rather than an interrupt).

## Verification added

Extended `install/test-download-progress.sh` with the env-provisioner's PTY/SIGINT harness plus
five new cases: Ctrl-C during a curl download exits promptly with no spam and no orphaned process,
same for wget, a single Ctrl-C is sufficient (no need for the user to hit it twice), a destination
deleted mid-transfer breaks the polling loop without spamming, and a second Ctrl-C sent immediately
after the first does not double-run cleanup. Confirmed the suite actually detects a regression by
reverting each of the three mechanisms independently and rerunning: all three reversions failed the
suite for the reasons described above, then passed again once reverted back to the shipped fix.
