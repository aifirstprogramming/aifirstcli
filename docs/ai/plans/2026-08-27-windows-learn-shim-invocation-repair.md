---
feature_id: aifirst-windows-learn-harness-repair-20260825-r2
date: 2026-08-27
shipped: true
---

# Windows learn shim invocation repair

## Problem

The published candidate found Claude with a bare command name and then asked
Node to spawn a `.cmd` file with `shell: false`. Windows cannot execute that
batch shim through the direct process path, so all three learn harness cases
returned exit code 1 before the fixture could capture arguments.

## What I verified

I checked the failing candidate and reproduced the available Linux learn tests
inside the project container. I also confirmed that the Windows fixture creates
only `claude.cmd`, which tests PATH lookup instead of relying on a Unix-style
bare executable. The focused learn and session tests passed after the repair.

## Decisions

I kept the child environment and Claude argument list unchanged. Windows PATH
lookup now checks the command, `.cmd`, and `.exe` forms. When the selected
command is a `.cmd` shim, the launcher calls the native `ComSpec` with a quoted
command line, preserving arguments that contain spaces and shell characters.
Unix executables still launch directly with `shell: false`.

I did not widen timeouts, weaken assertions, or change session cleanup. Native
Windows execution remains a required CI check because Linux cannot exercise the
Windows process launcher.

## Verification

I ran the focused learn and session tests, TypeScript checks, content sync, the
full `bun run check`, a negative mutation probe, and `git diff --check`. Fresh
CI runs on the pushed candidate must provide the Windows, Ubuntu, macOS,
PowerShell, and ShellCheck evidence before release review.
