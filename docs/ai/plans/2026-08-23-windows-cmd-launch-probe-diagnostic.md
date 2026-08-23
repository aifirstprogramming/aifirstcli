---
feature_id: t_1f79d96c
date: 2026-08-23
shipped: false
---

# Windows cmd launcher path diagnostic

## Problem

The first native Windows probe rejected direct Bun and options-object launches
before the fixture started. Its cmd.exe string candidate also failed before
writing the captured argv, so the report did not show whether the problem was
specific to a path containing an ampersand or affected an ordinary `.cmd` path.

## What I verified

I started from `b410903`, the commit tested by the first native Windows run. The
existing direct-launch expectation was stale: Bun now reports a clean
`TypeError` for a command name containing cmd.exe metacharacters, rather than an
`EINVAL` string. The Linux focused probe remains skipped because it must execute
on Windows, while TypeScript can still validate the harness locally.

## Decision

The probe now builds two cmd.exe `/d /s /c` command strings. One points to a
`.cmd` fixture under a path with spaces only. The other uses a path with spaces
and an ampersand. Both fixtures receive the same argv with spaces, an ampersand,
and a caret.

Each result records the command string, status, stdout, stderr, and captured
argv. A candidate counts only when it exits with status 0, writes both fixture
streams, and captures the complete expected JSON argv. The probe still does not
modify production source or select a launch adapter.

## Verification

The local focused test is skipped outside Windows. The typecheck and full Linux
check cover the changed test and documentation. Native Windows CI remains the
only evidence that can select a production design.
