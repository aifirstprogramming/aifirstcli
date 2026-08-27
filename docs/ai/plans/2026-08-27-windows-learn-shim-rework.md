---
feature_id: aifirst-windows-learn-harness-repair-20260825-r2-rework
date: 2026-08-27
shipped: true
---

# Windows learn shim rework

## Problem

The first Windows shim repair still returned exit code 1 before the fake Claude launcher captured its arguments. The Unix session test also replaced the existing PSModulePath with a Windows fixture value, so the test failed on Ubuntu.

## What I verified

I reproduced the focused learn and session tests on the published candidate inside the project container. The current launcher passed a command string to ComSpec that started and ended with the first and last argument quotes, but it did not add the outer pair required by `cmd.exe /s /c` for a quoted batch-file path. I also confirmed that the session environment normalizes the forwarded module-path key to `PSModulePath`, while its value comes from the platform process environment.

## Decisions

I kept the native ComSpec route, exact argument quoting, cleanup behavior, timeout, and strict Windows fixture assertions. The ComSpec payload now wraps the complete quoted command line, which lets `cmd.exe` execute the `.cmd` file while preserving the argument boundaries. The PSModulePath test sets its Windows fixture only on Windows and checks the pre-existing value on Unix, with a conditional key assertion when the platform has no module path.

I did not weaken exit-status checks or add a Unix-specific fake for a Windows process behavior. Native Windows CI remains necessary because Linux cannot execute the ComSpec path.

## Verification

I ran the focused tests after the edits, then ran the project check, typecheck, content synchronization check, diff check, and a negative mutation probe. The candidate branch must receive fresh exact-SHA CI across Windows, Ubuntu, macOS, PowerShell, and ShellCheck before release review.
