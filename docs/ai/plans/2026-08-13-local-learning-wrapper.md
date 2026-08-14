<!-- Captured from a feature implementation run. Do not edit: this is a historical record. -->

> **AI development artifact - implementation record.**
> This record describes the work completed for `t_6be9c7fd`.
> It is *history, not documentation*: where it disagrees with the code, the code is right.
>
> | | |
> | --- | --- |
> | **Feature** | `local-claude-wrapper-and-reader-output-aifirstcli` |
> | **Date** | 2026-08-13 |
> | **Outcome** | **Shipped on the feature branch** |

---

# Local learning wrapper

## Problem

Book mode already provides the local Anthropic Messages endpoint. It needs a command that starts that endpoint, launches Claude Code against it, and removes the temporary state when the reader leaves. The command must not alter the reader's normal Claude configuration or use its credentials.

## What I verified

I checked the existing `serve` command before changing it. It binds `127.0.0.1`, returns stored content, and has a test that counts outbound fetches. I also checked the argument parser, command allowlist, book-mode responder, and the existing session tests.

The implementation test uses a fake `claude` executable. It confirms the child receives `--bare`, a private settings file, a loopback URL, and a synthetic API key. It also confirms normal auth variables and `HOME` are absent, then confirms the session lock is removed. A second test confirms that the wrapper returns the child's nonzero exit code.

## Decisions

- `aifirst learn` starts the existing responder on port `0`. The operating system chooses an unused loopback port, which avoids a fixed-port collision.
- The wrapper starts Claude Code with `--bare --settings <private-settings>`. This preserves the reader's normal profile and does not write `~/.claude/settings.json`.
- The child gets a small environment containing platform launch variables, `PATH`, the local base URL, and a generated synthetic key. The wrapper does not pass authentication tokens into the local session.
- A versioned session file records paths owned by the wrapper. Recovery removes state only after the recorded processes are dead and the paths resolve under the wrapper's state directory. Malformed state remains untouched and `doctor` reports it.
- The local responder accepts only complete `aifirst` chat commands. It handles `next` and `show` locally, renders stored Code before Explanation, and returns text rather than a tool call for commands that need terminal handling. It refuses general prompts and withheld commands.

## Alternatives considered

I did not reuse `book-mode on` because it modifies the reader's persistent Claude settings. I did not use a fixed server port because another local server could already hold it. I did not forward the normal Claude environment because a local-only session should not have a path to normal authentication or configuration.

## Verification

`bun run check` passed: 238 tests passed, 0 failed, with 555 expectations. `bun run build:local` produced `bin/aifirst-linux-x64`. Focused tests also covered the fake Claude launch, session recovery states, exact command parsing, and an ephemeral loopback server.
