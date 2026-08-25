---
feature_id: aifirst-windows-learn-harness-repair-20260825-r2-rework
date: 2026-08-25
shipped: true
---

# Windows learn harness repair rework

## Problem

The first candidate preserved `PSModulePath`, but Windows CI still returned exit
status 1 for the learn fixture instead of the fixture's 0 or 7. The Linux test
also depended on whichever case-insensitive `PSModulePath` key the runner
already exported.

## What I verified

The launcher uses `node:child_process.spawn` with `shell: false`. Claude Code is
installed through a Windows command shim, so the child process cannot start the
`.cmd` launcher without a shell. The test fixture also creates the Unix fake
Claude file asynchronously before changing its mode, which made the local
baseline dependent on timing. The focused tests passed after awaiting that
write.

I checked the session fixture with every existing case-insensitive
`PSModulePath` entry removed. The test then sets one controlled key and restores
all original entries after the assertion. The production allowlist still emits
one canonical `PSModulePath` entry, so removing that allowlist entry makes the
fixture fail.

## Decisions

I kept the narrow environment and launch arguments unchanged. On Windows I
launch the resolved Claude command shim through the shell, while Unix keeps the
existing direct executable path. I made the executable lookup use one resolved
path instead of concatenating a suffix onto an absent result. I made the tests
restore all matching environment keys instead of assuming Linux and Windows
store them the same way.

The native Windows path remains unverified in this Linux container. GitHub
Actions must run the Windows-only PowerShell JSON test and the full suite at the
candidate SHA.

## Verification

The focused session and learn tests passed locally with 10 tests passing and one
Windows-only test skipped. The remaining typecheck, full check, content sync,
diff, mutation probe, and native Windows checks are recorded in the task handoff.
