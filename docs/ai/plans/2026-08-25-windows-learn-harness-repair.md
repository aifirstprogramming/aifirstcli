---
feature_id: aifirst-windows-learn-harness-repair-20260825-r2
date: 2026-08-25
shipped: true
---

# Windows learn harness repair

## Problem

The Windows learn tests failed while starting their PowerShell fixture. The
launcher ran with the intentionally narrow environment used by `aifirst learn`,
but that environment did not carry `PSModulePath`. The three reported failures
were the narrow-environment launch and cleanup test, exact PowerShell JSON
argument capture, and Claude exit-status propagation.

## What I verified

I fetched `origin/main` at execution time and reproduced the available Linux
focused baseline: two learn tests passed and the Windows-only test skipped. The
source call path uses `claudeLaunch()` to construct the child environment before
`spawn()` starts Claude. The Windows fixture invokes `powershell.exe`, so the
child must retain the host PowerShell module path while still excluding HOME and
Claude credentials.

I removed the new environment entry in an adversarial probe. The focused session
test then failed because `PSModulePath` was undefined. Restoring the entry made
the focused tests pass again.

## Decisions

I kept the allowlist model and added only `PSModulePath`. The lookup is
case-insensitive because Windows environment names are case-insensitive, while
the emitted child key uses the canonical spelling expected by PowerShell. I did
not widen the environment, change launch arguments, weaken cleanup assertions,
or platform-gate the tests.

The focused learn harness remains unchanged apart from the existing awaited
fixture writes on the base branch. Native Windows execution is deferred to fresh
GitHub Actions verification at the candidate SHA, so local Linux results do not
claim native Windows success.

## Verification

The candidate was checked with the focused learn tests, the session tests, the
TypeScript typecheck, the full `bun run check`, content synchronization, and
`git diff --check`. The exact command output and candidate SHA are recorded in
the task handoff.
