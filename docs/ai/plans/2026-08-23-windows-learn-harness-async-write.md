---
feature_id: windows-learn-harness-async-write
date: 2026-08-23
shipped: false
---

# Windows learn harness async-write repair and verification plan

## Root cause and focused repair

`runLearn()` creates fake Windows client fixtures and then starts the learn
client with `Bun.spawn`. `Bun.write()` is asynchronous. The PowerShell capture
script, `claude.cmd` launcher, and bare `claude` launcher were previously
started without awaiting their writes, so process startup could win the race and
resolve a launcher before its required fixture existed.

The repair is deliberately limited to `test/learn.test.ts`: await the writes of
`claude-capture.ps1`, `claude.cmd`, and bare `claude` before `Bun.spawn`. The
bare launcher remains necessary because Windows command lookup tests the bare
name before appending `.cmd`.

The existing assertions remain strict and unchanged: the test checks the exact
leading client arguments, narrow synthetic child environment, cleanup of the
learn session, and propagated client exit status. The Windows-only JSON test
continues to verify the complete PowerShell argument vector, including special
characters.

## Deterministic bootstrap and identity

The requested SSH target, `/home/neo/projects/_work/aifirstcli-windows-async-write-impl`,
could not be reached because `neo` rejected both public-key and password SSH
authentication. The recovery therefore uses the assigned scratch clone only:

- Repository: `https://github.com/aifirstprogramming/aifirstcli.git`
- Default branch fetched: `origin/main`
- Base SHA: `822cb0b885ea300bcf347b2ed48cf7566fc5b76e`
- Effective configured Git identity: `Stephen Chin <1290231+steveonjava@users.noreply.github.com>`

The worktree does not define a local `user.name` or `user.email`; the verified
effective identity comes from the configured Git lookup. The finalization task
must recheck that exact effective identity before creating a local commit.

## Adversarial probe

The repair was tested with a controlled delayed-write reader. Temporarily
removing the `await` from the `claude.cmd` write made the reader exit with status
1 because the fixture was absent at spawn time. Restoring the await made the
fixture available before spawning. The production test change has the await
restored; this probe is evidence of the race, not a retained test modification.

## Evidence and required final checks

The implementation handoff recorded these completed checks:

- `git diff --check` exited 0.
- `./.bun/bin/bun test test/learn.test.ts` exited 0: 2 passed and 1
  Windows-only test skipped on this host.
- `./.bun/bin/bun run typecheck` exited 0.
- Before this plan was added, `git status` showed only `test/learn.test.ts`
  modified.

Before the candidate commit, finalization must run `bun run check`, `bun run
typecheck`, and `git diff --check`, then inspect the content synchronization
result. `bun run check` includes `sync-content --check`, TypeScript checking,
and the full Bun test suite. This repair and plan do not change managed content;
a content-sync check must therefore report no required content update.

The candidate SHA is intentionally not assigned yet. Finalization must create a
local, unpushed candidate commit based on the recorded base SHA and record its
SHA. Its changed-file scope must be exactly:

- `test/learn.test.ts`
- `docs/ai/plans/2026-08-23-windows-learn-harness-async-write.md`

No production code, generated files, or unrelated documentation belong in that
commit.

## Native-Windows status

No native Windows host was available for this repair. The focused test provided
Linux-host evidence for the harness and skipped its Windows-only case as
designed. Native Windows execution, including PowerShell launcher behavior,
remains required before making a native-Windows success claim.
