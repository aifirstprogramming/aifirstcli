# AI development artifacts

This CLI was built with [Claude Code](https://claude.com/claude-code). Before each substantial
change, the agent wrote a plan — the problem, what it measured rather than assumed, the design
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
whether it shipped. The body below that block is **verbatim** — deliberately not cleaned up, because
an edited plan is no longer evidence of what was actually decided. The only alteration is that
absolute paths from the machine it ran on were replaced with `<scratch>/` and `~/`.

## Plans

| Plan | Date | Outcome |
| --- | --- | --- |
| [CLI implementation](plans/2026-08-07-cli-implementation.md) — the original design: content embedding, agent skills, cross-platform release, install one-liner | 2026-08-07 | Shipped as v0.1.0 |
| [v0.2.0 — fixes from first real use](plans/2026-08-07-v0.2.0-fixes-from-first-use.md) — approval prompts, book selection, "done" meaning the code ran, interactive exercises | 2026-08-07 | Shipped as v0.2.0 |
| [v0.5.0 release](plans/2026-08-09-v0.5.0-release.md) — one exercise, one file | 2026-08-09 | Shipped as v0.5.0 |
| [Book mode](plans/2026-08-09-book-mode.md) — work the book in Claude Code with no model and no API calls | 2026-08-09 | Shipped as v0.6.0 |

**Not every release has a plan here.** v0.3.0, v0.3.1 and v0.4.0 were small enough to be made
directly, without a planning step, so there is nothing to capture. Their reasoning is in the
release notes.

## Sessions behind this repository

| Session | When | What it produced |
| --- | --- | --- |
| `62a2fb7f` | 2026-08-07 → 08-09 | Effectively all of it: v0.1.0 through v0.6.0, the `@aifirst/content` extraction, the GitHub releases, and the installers served from the website |

Separately, the CLI was used **as a reader would use it** — typing prompts from the page and working
real exercises — in five sessions across 2026-08-07 to 08-09 (`59350787`, `915bc9b1`, `80d3c6c9`,
`763cce10`, `0dd81cfd`). Those sessions are where the bug reports came from: the approval prompts,
the wrong book, exercises marked done without running, and `next` dragging you back to chapter 2
were all found by using the tool, not by testing it. The v0.2.0 plan above opens with four such
findings.

## Adding to this directory

When a plan is approved in a Claude Code session, save it here before the session ends — the
transcript is not a durable store. Keep the body verbatim, add the same provenance block, scrub any
absolute local paths, and add a row to the table above.
