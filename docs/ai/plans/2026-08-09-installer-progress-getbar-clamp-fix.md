<!-- Captured from a Claude Code session. Do not edit: this is a historical record. -->

> **AI development artifact, implementation plan.**
> This is the plan Claude Code proposed and worked from, captured verbatim from the session that
> produced it. It records the reasoning, the measurements and the trade-offs behind the change.
> It is *history, not documentation*: where it disagrees with the code, the code is right.
>
> | | |
> | --- | --- |
> | **Feature** | installer-progress-aifirstcli (rework) |
> | **Date** | 2026-08-09 |
> | **Outcome** | **Shipped** |

---

# Fix Get-Bar's fraction clamping in install.ps1

## Context

The original installer-progress plan (`2026-08-09-installer-progress.md`) shipped progress bars
for `install.sh`, `install.ps1`, and `aifirst update`, all reusing the look of `bar()` from
`src/output.ts`. The independent-verifier ran the shipped `install.ps1` against a real slow HTTP
server and found `Get-Bar` never rendered a partial fill: the bar stayed fully empty until the
download finished, then jumped straight to fully full.

## The bug

```powershell
$clamped = [Math]::Max(0, [Math]::Min(1, $Fraction))
```

Both `0` and `1` are Int32 literals. `[Math]` has no `Min(int, double)` or `Max(int, double)`
overload, so PowerShell's overload resolution binds `Min(int, int)` and `Max(int, int)`, coercing
the double `$Fraction` to an integer before the comparison. Any fraction strictly between 0 and 1
truncates to 0, so `$clamped` was 0 for the entire download and only reached 1 at the exact moment
`$Fraction` hit `1.0`. `$filled` was therefore always 0 or `$Width`, never anything in between.

This is a PowerShell-specific pitfall with no equivalent in the TypeScript `bar()` it was meant to
mirror: `Math.min(1, fraction)` in JS/TS always operates on doubles, so the same code shape is
correct there and wrong in PowerShell. Nothing in the original implementation plan called this
overload-resolution behavior out, and the bun test suite can't exercise PowerShell-only code, so
it shipped unverified.

## What I verified rather than assumed

- Extracted `Get-Bar` from the committed `install.ps1` (regex-matched the function body, not a
  reimplementation) and called it directly at fractions 0.07, 0.34, 0.68, and 1.0 with width 20.
  Before the fix this produced 0, 0, 0, 20 filled cells. After casting both literals to `double`
  (`[Math]::Max(0.0, [Math]::Min($Fraction, 1.0))`), it produced 1, 7, 14, 20, matching
  `Math.round(fraction * width)` exactly.
- Compared the fixed `Get-Bar` output against `bar()` in `src/output.ts` at the same four
  fractions, glyphs stripped of `bar()`'s ANSI color codes. They matched character-for-character.
- Installed PowerShell 7.4.6 into the devcontainer (no `pwsh` was present; the verifier had
  flagged this as the one path it could not execute directly either) and ran the full
  `Invoke-DownloadWithProgress` function against a local Python HTTP server that streams a 2MB
  body in throttled 64KB chunks. The captured stderr output showed the bar progressing through
  0% -> 23% -> 39% -> 56% -> 72% -> 88% -> 100% with visibly increasing fill, not a single jump
  from empty to full.
- Re-ran the full `bun run check` suite (223/223 pass) and `shellcheck --shell=sh install.sh`
  (clean) to confirm the fix didn't touch anything outside `install.ps1`.

## Decision

Fixed by making both `Math.Min`/`Math.Max` arguments explicit doubles rather than relying on
argument order, since PowerShell's overload resolution here isn't intuitive and a future edit
that reorders the arguments again would silently reintroduce the bug if only one literal were
cast. Considered swapping argument order alone (`[Math]::Min($Fraction, 1)`) since `Min(double,
int)` also has no matching overload but happens to promote the int to double when the first
arg is already double-typed in some .NET builds; rejected because that's exactly the kind of
implicit behavior the original bug relied on, and made both literals `double` for clarity as well
as correctness.

## Verification added

Added `install/verify-get-bar.ps1`: extracts the live `Get-Bar` function out of the shipped
`install.ps1` (not a reimplementation) and asserts filled-cell counts at four fractions. This is
the pwsh-level regression check the TS test suite structurally cannot provide, since PowerShell
overload resolution bugs don't exist in the TypeScript source it mirrors.
