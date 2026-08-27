---
feature_id: aifirst-windows-learn-harness-r2-native-shim-repair
date: 2026-08-27
shipped: true
---

# Windows learn ComSpec completion

## Problem

The published ComSpec candidate still timed out all three Windows learn tests.
The launcher used `/s /c`, passed a quoted batch payload verbatim, and waited
for the child's `exit` event. The failure left the fake PowerShell fixtures
locked, so the test never reached its assertions.

## What I verified

I inspected the exact fake `claude.cmd` and PowerShell launcher in
`test/learn.test.ts`, then compared the failed ComSpec variants in git history.
The Linux focused tests pass, but Linux cannot execute the native Windows path.
The project matrix therefore remains the required check for command-line
parsing and process completion.

## Decisions

I removed `/s` from the ComSpec invocation so `/c` receives the single outer
quoted command payload without the extra quote-stripping mode. I wait for the
child `close` event instead of `exit`, so cleanup starts only after inherited
stdio has closed. The exact per-argument quoting, narrow environment, cleanup,
exit status propagation, Unix behavior, and strict Windows assertions remain.

I did not raise the test timeout or weaken any assertion. I did not hide the
unrelated Java test failure.

## Verification

I ran the focused learn tests, typecheck, content synchronization check, and
diff checks in a container with the checkout mounted. The focused Linux run
passed two tests and skipped the Windows-only test. Fresh exact-SHA CI on the
feature branch must confirm the Windows learn results and all supported jobs.
