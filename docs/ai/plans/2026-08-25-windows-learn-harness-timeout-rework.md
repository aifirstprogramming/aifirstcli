---
feature_id: aifirst-windows-learn-harness-repair-20260825-r2-timeout-rework
date: 2026-08-25
shipped: false
---

# Windows learn harness timeout rework

## Problem

The previous candidate used `spawn(..., { shell: true })` for the Windows Claude
command shim. Exact Windows CI passed setup and typecheck, but all three learn
cases timed out after five seconds while Unix and macOS passed.

## What I verified

The failing candidate resolved the `.cmd` path correctly, then added Node's
shell wrapper around the command shim. The fixture itself writes a PowerShell
script and a `.cmd` launcher, and the launcher returns the requested status.
The timeout therefore occurred in the nested shell launch path, not in session
cleanup or the fixture's exit assertions.

I reproduced the current Linux cases and inspected the exact failed Windows job.
Linux cannot execute the native `.cmd` and PowerShell path, so I did not claim a
native reproduction. The focused tests and typecheck pass after replacing the
nested Node shell with one explicit `cmd.exe /d /s /c` invocation.

## Decisions

I keep Unix on direct `spawn` with the existing argument and environment contract.
On Windows I invoke `ComSpec`, falling back to `cmd.exe`, with one quoted command
line. This gives the `.cmd` shim the shell it needs without asking Node to add a
second shell layer. The helper quotes spaces and command metacharacters while
preserving the exact arguments received by the fixture.

I added a deterministic unit test for the command line and left the native
PowerShell JSON test unchanged. The Windows-only path still requires fresh
GitHub Actions evidence at the candidate SHA.

## Verification

The focused learn and session tests pass with 11 tests and one Windows-only skip.
Typecheck passes. The full check, content sync, diff check, mutation probe, and
native Windows run are recorded in the task handoff.
