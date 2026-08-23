# AI development artifacts

This CLI was built with [Claude Code](https://claude.com/claude-code). Before each substantial
change, the agent wrote a plan covering the problem, what it measured rather than assumed, the
decisions and their alternatives, the phases, and how the result would be verified. Those plans
were reviewed and approved before any code was written.

They lived in the agent's session history, which is local to one machine and disappears with it.
This directory checks them into the repository so that anyone working on the project can read
*why* the code looks the way it does, not just what it does.

## How to read these

**They are history, not documentation.** Each plan describes the code as it was expected to become
at one moment. Where a plan and the code disagree, the code is right. For current behaviour read
the [README](../../README.md) and `--help`; for what changed in a release, read the
[GitHub releases](https://github.com/aifirstprogramming/aifirstcli/releases).

Each file opens with a provenance block: the session it came from, the date it was approved, and
whether it shipped. The body below that block is **verbatim**: deliberately not cleaned up, because
an edited plan is no longer evidence of what was actually decided. The only alteration is that
absolute paths from the machine it ran on were replaced with `<scratch>/` and `~/`.

## Plans

| Plan | Date | Outcome |
| --- | --- | --- |
| [CLI implementation](plans/2026-08-07-cli-implementation.md): the original design, including content embedding, agent skills, cross-platform release, and the install one-liner | 2026-08-07 | Shipped as v0.1.0 |
| [v0.2.0 fixes from first real use](plans/2026-08-07-v0.2.0-fixes-from-first-use.md): approval prompts, book selection, "done" meaning the code ran, and interactive exercises | 2026-08-07 | Shipped as v0.2.0 |
| [v0.5.0 release](plans/2026-08-09-v0.5.0-release.md): one exercise, one file | 2026-08-09 | Shipped as v0.5.0 |
| [Book mode](plans/2026-08-09-book-mode.md): work the book in Claude Code with no model and no API calls | 2026-08-09 | Shipped as v0.6.0 |
| [Derive content count in CI](plans/2026-08-09-derive-content-count-in-ci.md): compute the smoke test's expected total from books/*.json instead of hardcoding it | 2026-08-09 | Shipped |
| [Content sync listener](plans/2026-08-09-content-sync-listener.md): react to `aifirstcontent`'s `repository_dispatch`, bump the pin, regenerate books, gate, and commit to main | 2026-08-09 | Shipped |
| [Installer progress missing redirect](plans/2026-08-10-installer-progress-missing-redirect.md): follow GitHub release redirects in `download_with_progress` instead of silently writing an empty file | 2026-08-10 | Shipped |
| [Installer Ctrl-C runaway](plans/2026-08-10-installer-ctrlc-runaway.md): kill the backgrounded downloader and re-raise SIGINT on Ctrl-C instead of leaving it orphaned | 2026-08-10 | Shipped |
| [Installer Ctrl-C mutation coverage](plans/2026-08-10-installer-ctrlc-mutation-coverage.md): add tty-independent tests that actually catch a dropped kill line or a dropped SIGINT re-raise, closing a gap two of the existing pty-driven tests missed | 2026-08-10 | Shipped |
| [Local learning wrapper](plans/2026-08-13-local-claude-wrapper-and-reader-output.md): isolate the child environment and record the native verification gate | 2026-08-13 | Shipped on the feature branch |
| [Reader-friendly skill response order](plans/2026-08-13-reader-friendly-skill-response-order.md): present code, then the stored Explanation, then real output, and stop implying the explanation comes from the book | 2026-08-13 | Shipped on the feature branch |
| [Learn command routing fix](plans/2026-08-14-learn-command-routing-fix.md): explain the no-slash-only chat command boundary Claude Code's own slash layer imposes, and add a live interactive regression test | 2026-08-14 | Shipped on the feature branch |
| [Showtail replay](plans/2026-08-14-showtail-replay-in-aifirst.md): import and replay cached Showtail transcripts through book mode and local learning | 2026-08-14 | Shipped on the feature branch |
| [Bare-mode learning UX](plans/2026-08-16-bare-mode-learning-ux.md): make `aifirst learn` reproduce the installed-skill workflow: `next` gives complete code/instruction, Claude writes/executes/explains, and success advances the learner; `show` is read-only; `run` is explicit write/execute/record | 2026-08-16 | Shipped on the feature branch |
| [Bare-mode learning UX: policy rework](plans/2026-08-16-bare-mode-learning-ux-rework.md): fix `next`'s Windows path handling and missing-runtime detection, correct the Java missing-JDK test to force the real code path, after the earlier policy audit's stale-snapshot report | 2026-08-16 | Shipped on the feature branch |
| [Windows learn launcher repair](plans/2026-08-23-windows-learn-launcher-repair.md): reject a missing Claude executable before constructing a Windows `.cmd` launcher, and make launcher failures diagnosable | 2026-08-23 | Candidate branch |
| [Windows cmd launcher probe](plans/2026-08-23-windows-cmd-launch-probe.md): compare native Bun and cmd.exe launch forms with paths and argv values containing cmd metacharacters | 2026-08-23 | Probe branch |
| [Windows cmd launcher path diagnostic](plans/2026-08-23-windows-cmd-launch-probe-diagnostic.md): separate ordinary and ampersand-containing fixture paths for cmd.exe string mode | 2026-08-23 | Probe branch |

**Not every release has a plan here.** v0.3.0, v0.3.1 and v0.4.0 were small enough to be made
directly, without a planning step, so there is nothing to capture. Their reasoning is in the
release notes.

## Sessions behind this repository

| Session | When | What it produced |
| --- | --- | --- |
| `62a2fb7f` | 2026-08-07 to 08-09 | Effectively all of it: v0.1.0 through v0.6.0, the `@aifirst/content` extraction, the GitHub releases, and the installers served from the website |

Separately, the CLI was used **as a reader would use it**: typing prompts from the page and working
real exercises: in five sessions across 2026-08-07 to 08-09 (`59350787`, `915bc9b1`, `80d3c6c9`,
`763cce10`, `0dd81cfd`). Those sessions are where the bug reports came from: the approval prompts,
the wrong book, exercises marked done without running, and `next` dragging you back to chapter 2
were all found by using the tool, not by testing it. The v0.2.0 plan above opens with four such
findings.

## Adding to this directory

When a plan is approved in a Claude Code session, save it here before the session ends: the
transcript is not a durable store. Keep the body verbatim, add the same provenance block, scrub any
absolute local paths, and add a row to the table above.

