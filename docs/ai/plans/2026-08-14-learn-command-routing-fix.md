# learn-command-routing-fix

**Session:** feature-implementer, 2026-08-14
**Shipped:** yes, on the feature branch (`feat/learn-command-routing-fix`)

## The problem

`aifirst next`, `/aifirst next`, `aifirst show <id>`, `aifirst progress`, and
`aifirst done <id>` all failed live inside a real `aifirst learn` session
(book mode on, real Claude Code binary), even though `test/bookmode-commands.test.ts`
and `test/learn-contract.test.ts` passed. Both suites construct message strings
by hand and never drive an actual client, so they could not see the gap between
what a real client sends and what those tests assumed.

## What was verified rather than assumed

A real `claude` binary (v2.1.232) was installed in the devcontainer and driven
directly against a real `aifirst serve` instance with `--bare` and a synthetic
loopback settings file, the same launch shape `src/learn/session.ts`'s
`claudeLaunch` uses. Two hypotheses from the backlog card were checked
independently rather than assumed:

1. **Whitespace fragility in `parseChatCommand`.** `parseChatCommand("aifirst next\n")`
   does return `undefined` in isolation, as the card noted. But capturing the exact
   request body a real `claude --bare -p "aifirst next"` sends showed the client
   never sends a trailing newline for typed plain text; the last user-turn text
   block was the bare string `"aifirst next"`, byte for byte. This half of the
   hypothesis did not reproduce against a real client, so `parseChatCommand`
   itself was left unchanged. Loosening its whitespace handling on a false lead
   would have weakened the deliberate rejection boundary
   `test/bookmode-commands.test.ts`'s `"rejects prose, whitespace variants, and
   flags"` case protects, for no live benefit.
2. **Claude Code's own slash-command interception.** This reproduced immediately
   and unconditionally. `--bare -p "/aifirst next"` returns `Unknown command:
   /aifirst` client-side, before any HTTP request reaches `aifirst serve`. This
   was confirmed by pointing the same client at a request-logging stand-in server
   and observing zero requests for the slash form, versus one for the no-slash
   form. The same client-side rejection also held for the installed hyphenated
   commands (`/aifirst-next`, `/aifirst-example`, `/aifirst-progress`, written by
   `commandFiles()` to `~/.claude/skills/aifirst/commands/*.md`) under `--bare`:
   `Unknown command: /aifirst-next`. A flat `~/.claude/commands/*.md` layout and a
   base `aifirst.md` command file both resolve normally without `--bare`, but none
   of the layouts tried resolve under `--bare` specifically. `--bare`'s own
   `--help` text promises "Skills still resolve via /skill-name", which is true:
   `/aifirst` alone still routes to the skill under `--bare` in principle. But no
   registered command spells the space-separated `/aifirst next` invocation shape
   at all, hyphenated or not, so that promise does not cover this case.

## Decision

The actual defect was narrower than the card's root-cause section anticipated:
only the slash form is unreachable, and it is unreachable at the Claude Code
client layer, entirely outside this codebase. There is no code fix available
for that half. `--bare` mode's own command-resolution behavior is not
something `aifirstcli` controls. The fix taken is the card's documented
alternative (b): every place that told a learner `/aifirst next` works in chat
now says plainly that book mode's chat surface is no-slash-only, and why.
Changed: `localHelp()` and `chatCommandError()`'s generic message in
`src/bookmode/commands.ts`, the `refusal()` help lines in
`src/bookmode/responder.ts`, the README's Local learning session section, and
`docs/learn-verification.md`'s native verification step 3.

`parseChatCommand` and the command files in `src/skills/content.ts` are
unchanged: the parser already accepts the exact string shape a real client
sends for the no-slash form, and the installed hyphenated slash commands are
correct for every Claude Code mode except `--bare`, which is a real client
limitation, not a bug in what was installed.

## How the result was checked

`test/learn-interactive-regression.test.ts` is new: it starts a real
`aifirst serve` instance and drives a real `claude --bare` process against it
for every named safe form (`next`, `show`, `progress`, `done`, all without a
leading slash), one withheld command, one malformed/embedded-prose input, and
the slash form itself, asserting that the slash form is rejected client-side
with `Unknown command`, which documents the platform boundary this fix
communicates around rather than silently expecting a fix that cannot exist in
this codebase. It skips loudly, with a console warning, if no `claude` binary
is on `PATH`, rather than falling back to a stubbed client the way
`test/learn.test.ts` and `scripts/verify-learn-local.ts` do. That stubbed
pattern is exactly what let this bug ship with green tests originally.

All 7 new live cases passed against `claude` v2.1.232 in the devcontainer.
`bun run check` passes except one pre-existing baseline failure
(`run > names a Java file after its public class and runs it`), confirmed
unrelated by reproducing it identically against unmodified `HEAD`
(`a5f4709`) before any change in this feature: the devcontainer has no `javac`
on `PATH`, so that test cannot pass regardless of this fix.

Mutation check on the documentation fix: reverting the wording changes in
`commands.ts`, `responder.ts`, the README, and `learn-verification.md` does not
change what the new interactive test asserts (it targets live behavior, not
help-text wording), so there is no code path a revert would make the new test
fail on for the slash-form case. The underlying platform behavior did not
change, only what learners are told about it. The no-slash forms
(`next`/`show`/`progress`/`done`) were confirmed to already work correctly
against `HEAD` before any change, so this feature made no functional change to
those paths; the new test protects them against a future regression rather
than proving it fixed something broken there.
