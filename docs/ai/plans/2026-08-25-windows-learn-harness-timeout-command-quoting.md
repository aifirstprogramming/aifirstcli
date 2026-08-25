---
feature_id: aifirst-windows-learn-harness-repair-20260825-r2-timeout-rework-cycle-free
date: 2026-08-25
shipped: false
---

# Windows learn harness timeout command quoting

## Problem

The explicit `cmd.exe /d /s /c` launch still treated a spaced `.cmd` path as
unquoted. The command string began with the executable's quote and ended with
the final argument's quote, so `/s` stripped that pair instead of preserving
the complete command payload.

## What I verified

I rebuilt the change from failed PR head `046ec1e8b8943f7a06b4d544e7221684e7924d9c`.
The existing helper preserved per-argument quoting, but its payload had no
outer quote pair. The focused regression assertion fails when the outer pair
is removed, which confirms that the test protects the specific Windows parsing
contract rather than only checking a generic command string.

## Decisions

I kept the explicit ComSpec invocation and added one outer quote pair around
the already quoted payload. This preserves forwarded argv, the narrow child
environment, cleanup, and exit-status handling while making a spaced shim path
one command under `cmd.exe /s`.

I left the native Windows test in place because Linux cannot execute the
PowerShell and `.cmd` fixture. Fresh native CI at the new PR head remains the
final platform-specific check.

## Verification

I ran the focused learn tests, typecheck, content sync check, full `bun run
check`, `git diff --check`, and a mutation probe that removes the outer quotes.
The focused and full checks passed. Native Windows verification is pending the
fresh PR run.