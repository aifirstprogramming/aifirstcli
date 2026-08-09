<!-- Captured from a Claude Code session. Do not edit: this is a historical record. -->

> **AI development artifact, implementation plan.**
> This is the plan Claude Code proposed and worked from, captured verbatim from the session that
> produced it. It records the reasoning, the measurements and the trade-offs behind the change.
> It is *history, not documentation*: where it disagrees with the code, the code is right.
>
> | | |
> | --- | --- |
> | **Session** | `content-sync-listener-cli` |
> | **Date approved** | 2026-08-09 |
> | **Outcome** | **Shipped** |

---

# Add a content-release listener to the CLI

## Context

The content repo (`aifirstprogramming/aifirstcontent`) already fires a `repository_dispatch`
event of type `content-released` when it cuts a release, with `client_payload.tag` set to the
release tag (for example `v1.4.0`). This CLI repo had no listener for that event. A content
release therefore notified nobody on the CLI side: the `@aifirst/content` pin in `package.json`
stayed on whatever tag was current at the last hand edit, the committed `books/*.json` and
`src/content/embedded.generated.ts` drifted behind upstream, and the CI in this repo happily
kept passing against the stale pack. Someone had to notice, by hand, that a new content release
had happened and open a PR to bump.

## What I measured rather than assumed

Before writing anything I checked the state of the repo live rather than trusting the spec:

- `ls .github/workflows/` showed exactly `ci.yml` and `release.yml`. No listener existed.
- `grep -R repository_dispatch .github/` returned nothing. Confirmed rather than inferred.
- Read the sender workflow on `aifirstcontent` to pin down the exact event name and payload
  field: `event_type: content-released`, `client_payload.tag: <tag>`. Not guessed.
- The default `GITHUB_TOKEN` permission on this repo is read-only. That means a workflow that
  wants to commit to `main` and open an issue needs an explicit `permissions:` block granting
  `contents: write` and `issues: write`. Omit it and the commit and issue calls silently 403.
- The current pin is `github:aifirstprogramming/aifirstcontent#v1.4.0`. The installed version
  at `node_modules/@aifirst/content/package.json`'s `.version` field is what actually resolved;
  that is the value the sync script reads. The string in `package.json` and the resolved
  installed version are separate facts and can disagree.

## Decision

Add `.github/workflows/content-sync.yml` with the following shape:

1. Trigger on `repository_dispatch: types: [content-released]` (the exact sender event), plus a
   `workflow_dispatch` for manual dry runs with a `tag` input.
2. Job-level `permissions:` block granting `contents: write` and `issues: write`, no more.
3. Steps, in order: checkout `main` with `fetch-depth: 0` and the default token; resolve the
   tag from `client_payload.tag` or the manual input, failing loud if neither is set; set up
   bun; count the non-retired examples currently on `main` (for the commit message's before
   number); rewrite the `@aifirst/content` line in `package.json` to point at the new tag;
   `bun install` without the frozen flag (the lockfile just changed); a dedicated version
   assertion step that reads `node_modules/@aifirst/content/package.json`'s `.version` and
   fails the job if it does not equal the tag with a leading `v` stripped; then
   `bun scripts/sync-content.ts` to regenerate the committed books and the embedded content
   module; then `bun run check` (sync-content --check, tsc, `bun test`); then the same
   build-and-smoke-test sequence `ci.yml` runs, including the derived expected count from the
   sibling plan; then a commit step that runs only on success, checks for an actual diff, and
   commits with a message quoting old pin, new pin, and old and new non-retired counts; then
   a failure issue step that runs only on failure with the run URL in the body.
4. No `continue-on-error` anywhere. The commit only lands if every prior gate is green.

### Alternatives considered

- **Trust the pin string in `package.json` after editing it.** Rejected. A sibling repo shipped
  a false green from exactly this: the pin was rewritten, the install did not actually resolve
  the new tag for some reason (cache, network hiccup, whatever), and the workflow committed
  a "sync" that was just the old pack with a new label. Reading the resolved installed version
  and comparing to the requested tag is the cheap safeguard that catches this class of bug at
  the source. The version assertion is worth an extra step of its own.
- **Bump this repo's own `package.json` `version` on every sync.** Rejected for this feature.
  The sibling extension repo does this because its release cadence tracks content updates.
  This repo's version corresponds to CLI feature releases and is enforced against the git tag
  by `release.yml`'s "Tag matches package.json version" check. Bumping it inside a content-sync
  automation would fight that invariant. Content sync commits directly to `main` without cutting
  a CLI release; the next real CLI release picks up the synced content as a normal input.
- **Write a CHANGELOG entry.** Rejected. This repo has no `CHANGELOG.md`; release notes live
  on GitHub releases and are generated by `softprops/action-gh-release@v2` with
  `generate_release_notes: true`. Introducing a changelog only for this one automation would
  invent a second source of truth. The commit message on `main` is the record.
- **Use `jq` for the JSON edits.** Rejected on style. `ci.yml` uses `node -p` for its counting
  logic; `release.yml` uses `jq` in one place but the rest of that file's bash is plain shell.
  The new workflow stays with `node -p` and `node -e` throughout so a reader recognises the
  idiom from the neighbouring workflow they already know.

## How the result was checked

- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/content-sync.yml'))"` parses
  cleanly.
- `grep -A2 'repository_dispatch' .github/workflows/content-sync.yml` shows
  `types: [content-released]` exactly, not a wildcard.
- `grep -B2 -A2 'permissions' .github/workflows/content-sync.yml` shows the job-level
  `contents: write` and `issues: write` scopes.
- Traced the workflow's logic by hand step by step, checking each stage for the failure modes
  it is meant to catch: no tag from either input source, tag present but install resolves the
  wrong version, sync produces no diff, sync produces a diff but the gate fails, gate passes
  but the smoke test fails. Every failure path either exits non-zero before the commit step
  or triggers the failure-issue step.
- `bun run check` on the tree before this change was already green from the environment setup
  step (218 pass, 0 fail). This change only adds a workflow file and two doc files, so no
  code-affecting rerun was needed. `git status` before commit confirmed no non-workflow,
  non-doc files were modified.

## Risk carried forward

If the sender ever changes the event type or the payload field name, this listener silently
stops firing (repository_dispatch does not error when nothing matches; it just does nothing).
The mitigation is that the sender and listener are in sibling repos, so a change on the sender
side is discoverable, and a manual `workflow_dispatch` from the Actions tab remains a working
fallback. A monthly cron that runs `workflow_dispatch` against the currently-pinned tag as a
no-op would catch drift automatically, but is out of scope for this change.
