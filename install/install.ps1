<#
.SYNOPSIS
  AI First CLI installer for Windows.

.DESCRIPTION
  Run in PowerShell:

    irm https://aifirstprogramming.com/install.ps1 | iex

  Environment overrides:
    AIFIRST_VERSION      version to install (default: latest release)
    AIFIRST_INSTALL_DIR  where to put the binary (default: %LOCALAPPDATA%\Programs\aifirst)
#>

$ErrorActionPreference = 'Stop'

$Repo = 'aifirstprogramming/aifirstcli'
$Docs = 'https://aifirstprogramming.com'

$InstallDir = if ($env:AIFIRST_INSTALL_DIR) {
  $env:AIFIRST_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'Programs\aifirst'
}

function Write-Info($msg) { Write-Host "  $msg" }
function Write-Ok($msg)   { Write-Host "  " -NoNewline; Write-Host "OK" -ForegroundColor Green -NoNewline; Write-Host " $msg" }
function Die($msg) {
  Write-Host "error " -ForegroundColor Red -NoNewline
  Write-Host $msg
  exit 1
}

# --- Preconditions ---------------------------------------------------------

# TLS 1.2 for older Windows PowerShell 5.1, where the default can still be TLS 1.0.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

# --- Progress ---------------------------------------------------------------
#
# Invoke-WebRequest -UseBasicParsing gives no useful progress for a 92MB
# download, and $ProgressPreference is commonly set to SilentlyContinue for
# speed elsewhere, so it can't be relied on to show anything by default. We
# stream the download ourselves and render the same bar() look the CLI uses
# (src/output.ts: full/empty glyphs, width 20), so install, update and
# learner progress share one visual language.
#
# A real console host is interactive; anything else (redirected error output, a
# CI runner) gets periodic plain percentage lines instead. We render to
# stderr, so it is stderr's redirection state that decides this, the same
# rule install.sh applies via `[ -t 2 ]` rather than `[ -t 1 ]`.
$IsInteractiveHost = -not [Console]::IsErrorRedirected -and $null -ne $Host.UI.RawUI

function Get-Bar([double]$Fraction, [int]$Width = 20) {
  $clamped = [Math]::Max(0.0, [Math]::Min($Fraction, 1.0))
  $filled = [Math]::Round($clamped * $Width)
  if ($env:AIFIRST_ASCII -eq '1') {
    $full = '#'; $empty = '.'
  } else {
    $full = [char]0x2588; $empty = [char]0x2591
  }
  ([string]$full * $filled) + ([string]$empty * ($Width - $filled))
}

# Streams $Url into $Dest, rendering Get-Bar against Content-Length as bytes
# arrive. Falls back to a byte count with no percentage when the server
# doesn't report a length, same as the shell installer and update.ts.
function Invoke-DownloadWithProgress([string]$Url, [string]$Dest) {
  $request = [Net.HttpWebRequest]::Create($Url)
  $request.UserAgent = 'aifirst-installer'
  $response = $request.GetResponse()

  $total = $response.ContentLength
  $stream = $response.GetResponseStream()
  $fileStream = [IO.File]::Create($Dest)
  $buffer = New-Object byte[] 65536
  $done = 0
  $lastReport = [DateTime]::MinValue
  try {
    while ($true) {
      $read = $stream.Read($buffer, 0, $buffer.Length)
      if ($read -le 0) { break }
      $fileStream.Write($buffer, 0, $read)
      $done += $read

      $now = Get-Date
      if (($now - $lastReport).TotalMilliseconds -ge 150) {
        $lastReport = $now
        $doneMb = $done / 1MB
        if ($total -gt 0) {
          $pct = [Math]::Min(100, [int]($done * 100 / $total))
          $totalMb = $total / 1MB
          $line = "  {0} {1,3}%   {2:N1} / {3:N1} MB" -f (Get-Bar ($done / $total)), $pct, $doneMb, $totalMb
        } else {
          $line = "  {0}   {1:N1} MB" -f (Get-Bar 0), $doneMb
        }
        if ($IsInteractiveHost) {
          [Console]::Error.Write("`r$line")
        } else {
          [Console]::Error.WriteLine($line)
        }
      }
    }
  } finally {
    $fileStream.Close()
    $stream.Close()
    $response.Close()
  }

  $doneMb = $done / 1MB
  if ($total -gt 0) {
    $pct = [Math]::Min(100, [int]($done * 100 / $total))
    $totalMb = $total / 1MB
    $line = "  {0} {1,3}%   {2:N1} / {3:N1} MB" -f (Get-Bar 1.0), $pct, $doneMb, $totalMb
  } else {
    $line = "  {0}   {1:N1} MB" -f (Get-Bar 1.0), $doneMb
  }
  if ($IsInteractiveHost) {
    [Console]::Error.Write("`r$line`n")
  } else {
    [Console]::Error.WriteLine($line)
  }
}

# --- Detect architecture ---------------------------------------------------

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  'x86'   { Die "32-bit Windows is not supported. aifirst needs 64-bit Windows." }
  default { Die "unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

# A 32-bit PowerShell on 64-bit Windows reports x86 above; check the real OS too.
if ($env:PROCESSOR_ARCHITEW6432) {
  $arch = switch ($env:PROCESSOR_ARCHITEW6432) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { $arch }
  }
}

# Bun's default x64 build requires AVX2. Windows exposes no simple CPU flag query,
# so probe the plain build and fall back to -baseline if it won't start. That is
# more reliable than guessing from a CPU name string.
$variant = ''
$asset = "aifirst-windows-$arch$variant.exe"

# --- Resolve version -------------------------------------------------------

$version = $env:AIFIRST_VERSION
if (-not $version) {
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
      -Headers @{ 'User-Agent' = 'aifirst-installer' }
    $version = $release.tag_name
  } catch {
    Die "could not determine the latest version. Check your connection, or set AIFIRST_VERSION."
  }
}
$tag = if ($version.StartsWith('v')) { $version } else { "v$version" }
$base = "https://github.com/$Repo/releases/download/$tag"

Write-Host ''
Write-Host "  Installing aifirst $tag"
Write-Info "$asset -> $InstallDir"
Write-Host ''

# --- Download and verify ---------------------------------------------------

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("aifirst-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  $binaryPath = Join-Path $tmp $asset
  try {
    Invoke-DownloadWithProgress -Url "$base/$asset" -Dest $binaryPath
  } catch {
    Die "could not download $asset from $tag.`n    That build may not exist for this platform. See $Docs"
  }

  # Refuse to install an unverified binary: this file is about to be executed.
  $sumsPath = Join-Path $tmp 'SHA256SUMS'
  try {
    Invoke-DownloadWithProgress -Url "$base/SHA256SUMS" -Dest $sumsPath
  } catch {
    Die "could not download SHA256SUMS; refusing to install an unverified binary"
  }

  $expected = $null
  foreach ($line in Get-Content $sumsPath) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0]; break }
  }
  if (-not $expected) { Die "$asset is not listed in SHA256SUMS; refusing to install" }

  $actual = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Die "checksum mismatch for $asset`n    expected $expected`n    actual   $actual"
  }

  # --- Install -------------------------------------------------------------

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $target = Join-Path $InstallDir 'aifirst.exe'

  try {
    Move-Item -Path $binaryPath -Destination $target -Force
  } catch {
    Die "could not write to $InstallDir.`n    If aifirst is currently running, close it and try again."
  }

  # Verify it actually starts. On a pre-AVX2 CPU the standard build dies here, so
  # retry with the baseline artifact rather than leaving a broken install.
  $installedVersion = $null
  try {
    $installedVersion = (& $target --version 2>$null | Select-Object -First 1)
  } catch { }

  if (-not $installedVersion -and $arch -eq 'x64') {
    Write-Info "standard build did not start; trying the baseline build for older CPUs"
    $asset = "aifirst-windows-x64-baseline.exe"
    $binaryPath = Join-Path $tmp $asset
    Invoke-DownloadWithProgress -Url "$base/$asset" -Dest $binaryPath

    $expected = $null
    foreach ($line in Get-Content $sumsPath) {
      $parts = $line -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0]; break }
    }
    $actual = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $actual -ne $expected.ToLower()) { Die "checksum mismatch for $asset" }

    Move-Item -Path $binaryPath -Destination $target -Force
    $installedVersion = (& $target --version 2>$null | Select-Object -First 1)
  }

  if (-not $installedVersion) {
    Die "the installed binary would not run. Please report this at`n    https://github.com/$Repo/issues with your Windows version and CPU."
  }

  Write-Ok "aifirst $installedVersion installed"
  Write-Host ''

  # --- PATH ----------------------------------------------------------------

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$InstallDir*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $InstallDir } else { "$userPath;$InstallDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    # Update this session too, so the reader can continue immediately.
    $env:Path = "$env:Path;$InstallDir"
    Write-Info "Added $InstallDir to your PATH."
    Write-Info "Open a new terminal for it to apply everywhere."
    Write-Host ''
  }

  if ($env:AIFIRST_SKIP_SETUP -ne '1') {
    if ($IsInteractiveHost) {
      & $target init
      if ($LASTEXITCODE -ne 0) {
        Write-Info "Setup was not completed; run aifirst later to resume."
      }
    } else {
      Write-Info "Interactive setup skipped because no terminal is attached."
    }
    Write-Host ''
  }
  Write-Host "  Docs: $Docs"
  Write-Host ''
}
finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
