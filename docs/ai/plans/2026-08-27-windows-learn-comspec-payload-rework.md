---
feature_id: aifirst-windows-learn-harness-r2-native-shim-repair
date: 2026-08-27
shipped: true
---

# Windows learn ComSpec payload rework

## Problem

The first ComSpec repair used a `call` command and then let Node quote the
already-constructed payload. Fresh Windows evidence showed that every learn
case returned status 1 before the PowerShell capture could record its input.
The earlier verbatim variant stayed alive until the five second test timeout.

## What I verified

I compared the exact launcher payloads in the failed commits and kept the
fixture's PowerShell JSON capture unchanged. The failing shape was a batch path
inside a `/c` payload that was either parsed twice or wrapped with `call`.
The local focused tests still pass, but Linux cannot execute the native ComSpec
path, so the Windows matrix remains the deciding check.

## Decisions

I pass one canonical `/d /s /c` payload with the quoted batch path and each
quoted argument. I add the outer quote pair required by `cmd.exe` for a quoted
batch path and enable `windowsVerbatimArguments` only for this ComSpec path.
That prevents Node from escaping the payload a second time while preserving
spaces, shell-significant characters, and the child exit status. Unix launch
behavior, the narrow environment, and cleanup stay unchanged.

## Verification

I ran `bun install --frozen-lockfile` and the focused learn tests before the
edit, with two passing tests and one Windows-only skip. After the edit, the
focused tests, content sync, typecheck, full check, and diff checks passed.
Linux skipped the native Windows case, so fresh CI for the resulting commit
must confirm the Windows learn results and all supported jobs.
