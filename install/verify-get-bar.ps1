#!/usr/bin/env pwsh
# Regression check for Get-Bar's fraction clamping (see docs/ai/plans/2026-08-09-installer-progress-getbar-clamp-fix.md).
#
# [Math]::Min(1, $Fraction) used to resolve to the Math.Min(Int32, Int32)
# overload because the literal 1 is typed as Int32 in PowerShell, which
# truncated the double $Fraction to 0 or 1 before it ever reached the width
# scaling. That made the bar render fully empty until ~50% progress, then
# jump straight to fully full. This script extracts Get-Bar from install.ps1
# and asserts intermediate fill widths at several fractions so that bug can't
# come back silently.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installPs1 = Join-Path $scriptDir 'install.ps1'
$source = Get-Content -Raw $installPs1

# Pull just the Get-Bar function body out of install.ps1 so we exercise the
# exact shipped code, not a reimplementation.
if ($source -notmatch '(?ms)^function Get-Bar\(.*?\n\}') {
  throw "Could not locate Get-Bar function in $installPs1"
}
Invoke-Expression $Matches[0]

$cases = @(
  @{ Fraction = 0.07; Expected = 1 },
  @{ Fraction = 0.34; Expected = 7 },
  @{ Fraction = 0.68; Expected = 14 },
  @{ Fraction = 1.0;  Expected = 20 }
)

$failures = 0
foreach ($case in $cases) {
  $result = Get-Bar -Fraction $case.Fraction -Width 20
  $filled = ($result.ToCharArray() | Where-Object { $_ -eq [char]0x2588 }).Count
  $status = if ($filled -eq $case.Expected) { 'OK' } else { 'FAIL'; $failures++ }
  Write-Host "$status fraction=$($case.Fraction) filled=$filled expected=$($case.Expected) bar='$result'"
}

if ($failures -gt 0) {
  Write-Error "$failures/$($cases.Count) Get-Bar cases failed"
  exit 1
}

Write-Host "All Get-Bar fraction cases produced progressive fill widths."
