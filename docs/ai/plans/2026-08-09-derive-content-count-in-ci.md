<!-- Captured from a Claude Code session. Do not edit: this is a historical record. -->

> **AI development artifact, implementation plan.**
> This is the plan Claude Code proposed and worked from, captured verbatim from the session that
> produced it. It records the reasoning, the measurements and the trade-offs behind the change.
> It is *history, not documentation*: where it disagrees with the code, the code is right.
>
> | | |
> | --- | --- |
> | **Session** | `20260809_121935_a32730` |
> | **Date approved** | 2026-08-09 |
> | **Outcome** | **Shipped** |

---

# Derive the CI smoke-test's expected content count instead of hardcoding it

## Context

The "Build and smoke test" step in `.github/workflows/ci.yml` checked the compiled binary's
`progress --format json` output against a literal number: `grep -q '"total": 139'`. That number
is correct against today's content pack, but it's a tripwire against a value that has nothing to
do with whatever change a given CI run is actually testing. The next content release changes the
active example count and this step fails for a reason unrelated to the code under test.

## What I measured rather than assumed

I ran the counting logic directly against the committed `books/*.json` files inside the
devcontainer before touching the workflow:

```
$ node -p "let t=0;const fs=require('fs');for(const f of fs.readdirSync('books')...) ..."
139
```

That matches the current hardcoded value, confirming the derivation logic is correct rather than
just plausible. I did not trust the number in the spec; I reproduced it.

## Decision

Replace the literal `139` with a value computed at CI run time, directly from the checked-in
`books/*.json` files, with no network call and no dependency on `@aifirst/content`'s internals:

```bash
EXPECTED=$(node -p "let t=0;const fs=require('fs');for(const f of fs.readdirSync('books').filter(x=>x.endsWith('.json'))){const d=JSON.parse(fs.readFileSync('books/'+f));for(const s of d.sections||[])for(const c of s.chapters||[])for(const e of c.examples||[])if(e.status!=='retired')t++;}t")
"$BIN" progress --format json | grep -q "\"total\": $EXPECTED"
```

The count excludes examples whose `status` is `"retired"` and includes everything else (no status
field, or any other status). This matches the pack's own publication-state semantics: only
`retired` examples are excluded from progress totals.

### Alternatives considered

- **Range check (`total > 0`)**: rejected. This assertion is the only test proving the compiled
  binary embeds content and runs standalone with no network; weakening it to a non-zero check
  loses the real regression coverage (e.g. it would pass even if the binary embedded half the
  pack).
- **Helper script under `scripts/`**: considered, since a `.ts` file would be easier to unit test.
  Kept it inline instead, since the spec's scope explicitly excludes touching `scripts/`, and an
  inline `node -p` one-liner needs no build step and runs identically on all three CI runner OSes
  (ubuntu, macos, windows) since bun ships its own node-compatible runtime everywhere.
- **Hardcoding a new fixed number after re-counting**: rejected outright. That just moves the
  same fragility one release forward. The whole point of this change is that the number is
  derived, not chosen.

## How the result was checked

- Ran the exact derivation one-liner standalone against the current pack: got `139`, matching the
  value it replaces.
- `bun install --frozen-lockfile && bun run check` (sync-content --check, tsc, `bun test`): 218
  pass, 0 fail, matching the pre-change baseline. One run produced a single unrelated flaky
  failure in the book-mode server test (a local port race); a clean rerun confirmed it wasn't
  caused by this change.
- `bun scripts/build.ts --local` then ran the modified grep line against the built binary's
  `progress --format json` output: passed, with `EXPECTED=139`.

## Risk carried forward

If a future content release adds a new `Status` value beyond `"draft"` and `"retired"`, this
derivation's exclusion filter needs a matching update. Re-verify the counting logic whenever the
content pack's schema changes upstream in `@aifirst/content`.
