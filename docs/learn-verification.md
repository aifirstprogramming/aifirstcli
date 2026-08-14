# Local Learning Verification

This document is the release gate for `aifirst learn`. The automated fake-client
suite is necessary but does not replace native Claude Code checks.

## Boundary

Run each platform check with a fresh test account and a sentinel normal Claude
profile. The sentinel must include settings, skills, hooks, and credential/state
markers. Record hashes before and after. Do not record credentials, request
bodies, or full child environments.

The local responder must bind only to `127.0.0.1`. The session must use a
synthetic child-only `ANTHROPIC_AUTH_TOKEN`, `IS_DEMO=1`, and an ephemeral
`ANTHROPIC_BASE_URL`. The normal profile must remain byte-for-byte unchanged.

## Native Matrix

### Linux

1. Install the supported Claude Code binary and record `claude --version`.
2. Run `aifirst init`, then `aifirst learn -- --print` with the sentinel profile.
3. Verify `aifirst next` (no leading slash) and `aifirst show py-1-01` produce Code before Explanation.
   `/aifirst next` is intercepted by Claude Code's own slash-command layer before it reaches book mode;
   it is not a supported chat form.
4. Verify `aifirst run <id>` records completion only after a successful Bash tool result.
5. Send an off-book prompt and confirm local refusal with no external request.
6. Exit normally, repeat with a client launch failure, and run `aifirst learn --recover` after a stale lock.
7. Run plain `claude` and verify the sentinel hashes and normal behavior are unchanged.

### macOS

Repeat the Linux matrix with the native macOS binary. Include normal exit,
Ctrl-C, SIGTERM, crash recovery, and stale-lock recovery. Confirm that the
platform profile location is session-owned and that no parent-wide `HOME`
mutation redirects AI First progress or unrelated tools.

### Windows

Repeat the matrix in PowerShell with the native Windows binary. Test process
termination with Ctrl-C and a terminated child, then run `aifirst learn --recover`.
Confirm that the session profile is removed only after successful cleanup and
that the sentinel profile and plain `claude` behavior are unchanged.

## Evidence Record

For every platform, attach the redacted output from
`scripts/verify-learn-local.ts`, the Claude version, the test date, and the
before and after sentinel hashes. A platform is not released until all matrix
steps pass with an actual native Claude Code binary. A fake client or a timeout
is evidence of an unverified gate, not a release claim.

Run the controlled harness from the repository root:

```sh
bun scripts/verify-learn-local.ts
```
