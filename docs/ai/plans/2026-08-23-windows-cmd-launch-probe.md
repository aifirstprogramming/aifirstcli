---
feature_id: t_e7044944
date: 2026-08-23
shipped: false
---

# Windows cmd launcher probe

## Problem

Three Windows launcher attempts failed in different ways. Directly spawning a
`.cmd` file returned EINVAL. A quoted executable reached cmd as a literal name.
The next command string produced a malformed path. The Linux suite cannot
choose between Windows launch adapters.

## What I verified

I started from `d79d1e0`, ran the installed Linux full check, and saw 332 pass,
15 expected skips, and no failures. I checked Bun 1.3.14's local types before
adding a candidate. Bun supports both `Bun.spawn(command, options)` and the
options-object `Bun.spawn({ cmd, ... })` form. It does not expose a `shell`
option for this API.

## Decision

I added a Windows-only test that writes a `.cmd` fixture under a directory with
spaces and an ampersand. Each candidate runs separately and receives an argv
value with spaces plus one with an ampersand and caret. The fixture records argv
as JSON and emits both stdout and stderr.

The matrix records direct Bun spawn, explicit `cmd.exe /d /s /c` string mode,
and Bun's documented options-object form. The test treats direct spawn's EINVAL
as a rejected baseline. It requires at least one remaining candidate to preserve
all argv values and both output streams. This probe does not alter `learn.ts` or
select a production adapter.

## Verification

The focused Linux test skips because it requires native Windows. TypeScript
checks the test harness on Linux. The full Linux check is the local regression
gate. Native Windows CI must provide the final matrix output before a later card
changes production launch behavior.
