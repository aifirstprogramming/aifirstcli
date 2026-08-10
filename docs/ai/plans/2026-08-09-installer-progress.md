<!-- Captured from a Claude Code session. Do not edit: this is a historical record. -->

> **AI development artifact, implementation plan.**
> This is the plan Claude Code proposed and worked from, captured verbatim from the session that
> produced it. It records the reasoning, the measurements and the trade-offs behind the change.
> It is *history, not documentation*: where it disagrees with the code, the code is right.
>
> | | |
> | --- | --- |
> | **Feature** | installer-progress |
> | **Date** | 2026-08-09 |
> | **Outcome** | **Shipped** |

---

# Progress bars for install.sh, install.ps1 and aifirst update

## Context

`install/install.sh`, `install/install.ps1` and `src/commands/update.ts` each download a binary
(or a set of book packs) with a plain, silent request: `curl -fsSL` piped straight to a file,
`Invoke-WebRequest -UseBasicParsing`, and a buffered `fetch().arrayBuffer()`. On a slow connection
or a large release asset, the learner sees nothing move for as long as the download takes, and has
no way to tell a hang from a large file in flight.

## What I verified rather than assumed

- Read `src/output.ts`'s `bar()` first, since the spec requires reusing it character-for-character:
  width 20, full glyph `█` / empty glyph `░`, with an ASCII `#`/`.` fallback. I did not invent a
  second bar style; both new implementations render the identical look.
- Confirmed the spec's TTY rule against the actual bug it prevents: `install.sh`/`install.ps1` are
  piped into `bash`/`iex`, so **stdout is never a TTY** on the real install path. Testing `[ -t 1 ]`
  or PowerShell's `IsOutputRedirected` would report "not interactive" even on a real terminal,
  because it's stdin/stdout on the wrapping pipe that's redirected, not the terminal itself. The
  bar has to render to stderr and gate on stderr's own TTY state (`[ -t 2 ]` in POSIX,
  `[Console]::IsErrorRedirected` in PowerShell) to ever show up for a real user. I caught this in
  `install.ps1` mid-implementation: my first draft checked `IsOutputRedirected`, tested clean in a
  non-interactive harness (which doesn't distinguish the two), and only failed on inspection
  against the spec's explicit rule. Fixed before commit.
- Did not trust "the bar renders" without seeing intermediate frames. A bar that jumps straight
  from 0% to 100% is functionally decorative, not tested. I stood up a throttled local HTTP server
  in each language runtime (a Python throttled server for the shell installer's harness, and a
  `Bun.serve` `ReadableStream` with a `setTimeout` between chunks for update.ts's test suite) and
  captured actual output, confirming a real staircase of percentages (14% -> 28% -> ... -> 100%,
  not just two frames).
- Confirmed `curl`'s own progress meter needed suppressing (`-s`) while keeping `-f -S` so HTTP
  error bodies still surface (`curl: (22) ... 404` stays intact). The custom renderer replaces
  curl's meter rather than stacking a second one underneath it.
- Confirmed non-TTY output stays plain: redirected to a file, none of the three implementations
  emit a carriage return or ANSI escape, only periodic full lines. Verified this directly for
  `update.ts` by monkey-patching `process.stderr.write` in a test and asserting on the captured
  bytes.

## Decisions and alternatives

- **Custom byte-counting renderer over the tool's built-in progress meter, in all three
  languages.** `curl`'s own meter, `Invoke-WebRequest`'s default progress bar, and a plain `fetch`
  all render differently from each other and from `bar()`. The spec's requirement is one visual
  language across install, update and the exercise-progress bar in `output.ts`, and that's only
  reachable by driving the bar off the byte count ourselves in each case.
- **`update.ts`: stream via `res.body.getReader()` instead of `arrayBuffer()`/`text()`.** This was
  the only way to observe bytes arriving incrementally; a buffered read gives one data point at the
  very end, which cannot drive a progress bar at all. Chunks are collected into a `Uint8Array[]`
  and concatenated once the stream ends, so the eventual checksum/write path is unchanged. The
  streaming only changes when bytes become visible, not what ends up on disk.
- **No dependency added.** All three renderers are hand-rolled against runtime primitives
  (`curl`'s output suppressed and progress derived from a du/stat-style measurement of the
  partially-written file in `install.sh`, `[Net.HttpWebRequest]` streamed manually in
  `install.ps1`, `ReadableStream` reads in `update.ts`). The spec ruled out a new dependency and
  a second bar style; a library would risk both.
- **`update.ts`'s SHA256SUMS fetch stays a plain buffered `fetch()`.** That file is a few hundred
  bytes; adding progress rendering to it would be pure noise and the spec only requires progress on
  the download that's actually slow (the binary / book assets).
- **Render throttling**: `update.ts` redraws at 100ms on a TTY and 2s otherwise; `install.sh` and
  `install.ps1` use a comparable interval. This keeps the redraw rate visually smooth without
  flooding a piped log with one line per chunk on a fast connection.

## How the result was checked

- `install/install.sh`: `sh -n` (syntax) and `shellcheck --shell=sh` (installed via
  `sudo apt-get install -y shellcheck` in the devcontainer) both clean. Ran the download-progress
  functions in isolation against a throttled Python HTTP server (6 MiB synthetic asset, 64 KiB
  chunks): confirmed a gradual percentage sequence in TTY mode (via `script -qec` to allocate a
  pty) and confirmed plain, CR-free lines when output was redirected to a file. Confirmed the 404
  path preserves curl's own error text.
- `install/install.ps1`: parsed with
  `[System.Management.Automation.Language.Parser]::ParseFile` under PowerShell 7.6.4 (installed
  manually into the devcontainer, since `apt-get install powershell` has no package on this base
  image). Ran the extracted `Invoke-DownloadWithProgress`/`Get-Bar` functions against the same
  throttled server: confirmed a gradual unicode-bar sequence, confirmed a 404 raises so the
  caller's existing `Die` path still triggers, and confirmed the fix from stdout- to
  stderr-redirection detection didn't regress parsing.
- `src/commands/update.ts`: added `test/update-progress.test.ts` exercising the extracted
  `fetchWithProgress` helper: full-content correctness, a server that omits `Content-Length`, a
  404 raising `CliError`, a Content-Length-driven percentage line, and a non-TTY run asserted to
  contain no `\r` and no ANSI escape sequence.
- Full suite: `bun install --frozen-lockfile && bun run check` ran 223 pass, 0 fail (218 baseline
  plus the 5 new `update-progress.test.ts` cases), `tsc -p tsconfig.json` clean, content sync
  check clean.
- Confirmed `README.md:13`'s printed one-liner was not touched, and confirmed `git diff --stat`
  shows only the three files the spec named plus the new test file, with no drive-by formatting.

## Risk carried forward

- The `install.ps1` streaming download uses `[Net.HttpWebRequest]`, which is deprecated upstream in
  favor of `HttpClient` in newer .NET, but was kept because it works unmodified against Windows
  PowerShell 5.1 as well as PowerShell 7+, matching the installer's existing baseline-compatibility
  stance elsewhere in the file. If that stance changes, this is the one spot that would need
  revisiting alongside it.
