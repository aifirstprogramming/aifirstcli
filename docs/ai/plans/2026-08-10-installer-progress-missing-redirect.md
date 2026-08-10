<!-- Captured from a Hermes Agent session. Fresh authorship for this file: no prior AI session transcript exists to capture for a same-day one-flag fix. -->

> **AI development artifact, implementation plan.**
> This is the plan the agent worked from for this fix, written at the time the work happened. It
> records the root cause, what was verified rather than assumed, the decisions and their
> alternatives, and how the result was checked.
>
> | | |
> | --- | --- |
> | **Feature** | installer-progress-missing-redirect |
> | **Date** | 2026-08-10 |
> | **Outcome** | **Shipped** |

---

# Fix the missing -L on install.sh's download

## Context

`install/install.sh`'s `download_with_progress()` called curl as `curl -f -s -S -o ...`, dropping
the `-L` flag that the file's other two curl call sites use as part of `-fsSL`. GitHub release
asset URLs redirect with a 302 before serving the actual bytes. Without `-L`, curl follows none of
that: it writes the empty redirect body to the destination file and exits 0. The install then
failed at the checksum step with "aifirst-linux-x64 is not listed in SHA256SUMS", which pointed at
the wrong place. The release and its checksums were fine. The local file was empty.

This regression shipped through the original `installer-progress` feature because the verifier's
test harness used a throttled local Python server with no redirect hop, so nothing in that
pipeline stage ever exercised curl's redirect-following path.

## What I verified rather than assumed

- Measured the actual defect against a real GitHub release asset before touching anything: without
  `-L`, curl returned status 302 and wrote 0 bytes with exit code 0. With `-L`, it returned 200 and
  wrote the full 96565376-byte asset. Confirmed the failure mode described in the backlog card is
  exactly what happens, not a theoretical concern.
- Ran `bash install/install.sh` against a live GitHub release from a clean `AIFIRST_INSTALL_DIR`.
  The progress bar showed real intermediate values (3%, 4%, 5%, 6%, 7%, 49%, 100%), not a single
  jump, and `aifirst --version` printed 0.6.0 from the installed binary.
- Ran the same install with stderr redirected to a file and confirmed zero carriage returns in the
  captured output, so the non-TTY path still prints plain periodic lines.
- Proved the checksum gate still rejects bad downloads: patched a throwaway copy of install.sh to
  append garbage bytes to the downloaded asset before the checksum compare, ran it against a real
  release, and got a checksum-mismatch error with a non-zero exit and no installed binary.
- Confirmed a 404 on the release asset still fails cleanly with a non-zero exit, proving `-f`
  survived the rewrite to `-fsSL`.
- Did not just cite the spec's claim that `install.ps1` and `update.ts` are fine. Installed
  PowerShell 7.6.4 into the devcontainer and called `install.ps1`'s actual
  `Invoke-DownloadWithProgress` function against a local server that 302-redirects to a second
  endpoint. It followed the redirect and downloaded the full asset with a real progress render, so
  no code change was needed there. Also ran a Bun script that calls the same unmodified `fetch()`
  `update.ts` uses against the same 302 fixture and got the full byte count back, confirming Bun's
  default `redirect: "follow"` covers `update.ts` as well.
- Ran `shellcheck --shell=sh install/install.sh` (clean), `bun run check` (223 pass, 0 fail,
  matching the baseline from env provisioning), and the full `ci.yml` "Build and smoke test" step
  (`bun scripts/build.ts --local`, then the built binary's `--version`, `show py-1-01`, and
  `progress` content-count check), all passing.

## Decision

Restyled the curl call to `-fsSL` rather than bolting `-L` onto the existing `-f -s -S` spelling.
The file already uses `-fsSL` at its other two curl sites (the shebang comment and the
`content_length_for` HEAD request), so the naive fix would have left two different flag
conventions for the same tool in one file. Considered leaving the flags spelled out for
readability, but the file's own precedent settles that argument: match what is already there.

## Verification added

Added `install/test-download-progress.sh`, a POSIX shell test that stands up local HTTP fixture
servers (`install/fixtures/redirect_server.py`, `not_found_server.py`, `throttled_server.py`) and
exercises `download_with_progress()` directly against them for all five required cases: redirect
followed with full bytes, genuine intermediate progress percentages, no carriage returns in
non-TTY output, checksum mismatch rejected, and a 404 failing cleanly. This is a real transfer
test, not a source-text grep or a syntax check. I confirmed it actually catches the original bug
by temporarily reverting the `-L` flag and rerunning the suite: two of the five cases failed with
the exact symptom (0 bytes downloaded, no intermediate progress), then passed again once the fix
was restored.
