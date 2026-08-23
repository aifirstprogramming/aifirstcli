---
feature_id: windows-learn-launcher-repair
date: 2026-08-23
shipped: false
---

# Windows learn launcher repair

## Problem

The Windows learn tests returned exit status 1 for a normal launcher, the exact
PowerShell JSON capture, and a child that should return 7. The launcher lookup
built `undefined.cmd` when `claude` was absent from PATH. That string is truthy,
so the missing-client check did not run and the child process failed to spawn.

## What I verified

I checked the published base commit and the focused Linux suite before editing.
It passed two tests and skipped the Windows-only JSON case. The failed GitHub
job completed on `windows-latest`. Its public log archive requires GitHub
credentials in this environment, so I did not claim a log line I could not
retrieve. The source path itself explains the error: concatenating an undefined
lookup result yields `undefined.cmd`, which makes `spawn()` report a launcher
resolution failure.

## Decision

I store the lookup result before adding the Windows `.cmd` suffix. The command
now reports the documented missing-Claude error before starting a server or
spawning a child. I retained the bare-name lookup because the Windows fixture
and command lookup both require it before choosing the `.cmd` launcher.

I added a focused missing-client regression. It fails against the old code
because it tried to spawn a made-up executable. The existing success, exact
argument, environment, cleanup, and exit-propagation checks remain. Their
failure diagnostics now include stdout, stderr, and capture state. A missing
capture identifies PATH resolution or cmd-launcher failure, while an empty
capture identifies a PowerShell capture failure.

## Verification

The final gates run the focused test, TypeScript check, and full project check
inside the aifirst devcontainer. A new candidate branch triggers the required
native Windows CI run. That run is the evidence for PowerShell invocation and
Windows argument fidelity; this Linux host cannot make that claim.
