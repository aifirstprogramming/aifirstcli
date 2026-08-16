---
feature_id: bare-mode-learning-ux
date: 2026-08-16
shipped: true
attempt: 2
---

# Bare-Mode Learning UX: Policy Rework

I reworked bare-mode-learning-ux after the first policy audit rejected it. The audit's stale-worktree finding turned out to be a snapshot taken mid-fetch: once I fetched and confirmed the canonical worktree at `/home/neo/projects/_work/bare-mode-learning-ux-aifirstcli` and its devcontainer, both already sat on the intended ref 9d6a674, descended from the recorded merge base 11a81da with no rebase or added history.

I verified rather than assumed on the Java gate. Running the exact failing case, `run > names a Java file after its public class and runs it`, passed cleanly on its own: 520ms, one pass, zero fail. The full `bun run check` then showed a different failure: `bare-mode-learning-ux.test.ts`'s two "Java not installed" cases failed because this devcontainer has a real JDK, so `next java` ran the exercise instead of hitting the missing-runtime branch the tests meant to exercise. The earlier audit's EOF report came from a stale run against an unset PATH rather than a real defect in `next`.

I fixed two things. First, the tests now force `PATH=/nonexistent` for the missing-JDK scenario, so the assertion exercises the intended code path regardless of what's installed on the box. Second, `next.ts` had a real portability gap the audit flagged correctly: it built the run command from `path.split("/").pop()`, which breaks on a Windows backslash path, and it never checked whether `python3` or `java` were on PATH before spawning them, unlike `run.ts`'s equivalent path. I replaced the split with `node:path`'s `basename()` and reused the shared `runCommand()` helper from `@aifirst/content` that `run.ts` already calls, then added the same `which()` guard `run.ts` has so a missing runtime reports `missing_runtime` instead of letting `Bun.spawn` fail unpredictably.

The em dash the audit flagged in `docs/ai/README.md`'s plan-table row for this feature is fixed in a separate mechanical commit that only swaps the punctuation.

Checked: `bun run check` on the exact feature worktree/container, HEAD 58d8412 on `feat/bare-mode-learning-ux`, merge base still 11a81da. 327 pass, 12 skip (live-Claude and live-replay scenarios this environment cannot exercise), 0 fail. All three focused test commands from the spec's testing_requirements pass. Typecheck clean.
