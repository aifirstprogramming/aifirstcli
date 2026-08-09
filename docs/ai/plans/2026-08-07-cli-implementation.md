<!-- Captured from a Claude Code session. Do not edit: this is a historical record. -->

> **AI development artifact — implementation plan.**
> This is the plan Claude Code proposed and worked from, captured verbatim from the session that
> produced it. It records the reasoning, the measurements and the trade-offs behind the change.
> It is *history, not documentation*: where it disagrees with the code, the code is right.
>
> | | |
> | --- | --- |
> | **Session** | `62a2fb7f` |
> | **Date approved** | 2026-08-07 |
> | **Outcome** | **Shipped** — `431b4b3 Implement the aifirst CLI`, released as v0.1.0/v0.1.1 |

---

# AI First CLI — implementation plan

## Context

The AI First Apress book series (Java + Python) teaches AI-assisted programming. Today the only
companion tooling is the VS Code extension in `../aifirstextension` (published as
`AIFirstProgramming.ai-first-programming` v1.4.0), which serves book prompts/responses through a
`vscode.LanguageModelChatProvider` so readers get the book's exact code without burning Copilot
quota.

That leaves three gaps:

1. **Terminal-first readers are unserved.** Learners using Claude Code, Codex, or Antigravity have
   no companion at all, and must retype long prompts from the printed page.
2. **Results aren't reproducible.** A reader typing a book prompt into a real model gets a different
   answer than the book prints, which breaks the tutorial flow the book depends on.
3. **No sense of progress.** Nothing tells a learner which exercises they've completed or what's next.

This project builds `aifirst`, a single-binary CLI installed by one `curl` line, that installs skills
into every agent the learner has, serves the book's canonical answers byte-for-byte, and keeps a
personal learner log.

## Decisions already made

| Area | Decision |
|---|---|
| Determinism | **CLI-as-oracle** in v1: skills teach agents to fetch canonical answers from `aifirst` rather than generate them. Local fake-model server deferred to a later phase. |
| Content home | New **shared content repo** as single source of truth for both CLI and extension. |
| Runtime | **Bun + TypeScript**, `bun build --compile` to standalone per-platform binaries. |
| Shared code | Content repo ships a **TS core package** (types, loader, matcher, ids); both CLI and extension consume it. |
| Learner log | **Student's own ledger.** No verification machinery, no anti-cheat. |
| Completion | Auto-on-apply, agent-reported, self-reported. **No** `check`-style verification. |
| Channels | **`curl \| bash` + `irm \| iex` only** for v1. No npm/brew/winget. |
| Exercise IDs | **Authored explicit IDs** in content JSON. |
| Install host | **aifirstprogramming.com** |
| `init` | **Detect all, confirm once, install** into everything found. |
| Content delivery | **Embedded in binary + refreshable** via `aifirst update`. |

## Architecture

Three repos under the `aifirstprogramming` org:

```
aifirstcontent/                 NEW — single source of truth
  books/ai-first-python-programming.json
  books/ai-first-java-programming.json
  schema/content.schema.json
  src/{types,loader,matcher,ids,index}.ts     -> published as @aifirst/content
       |                                    |
       v                                    v
aifirstcli/  (NEW, bun+TS)          aifirstextension/  (EXISTING, refactor)
  embeds books/ via --asset           replaces its duplicated loader+matcher
  writes skills into 4 agents         with @aifirst/content
  keeps ~/.aifirst/progress.json
```

The critical property: **the CLI and the extension resolve a prompt to a response using the same
`matcher.ts`.** Today `AIFirstLanguageModelProvider.ts` and `AIBookProvider.ts` each re-walk the book
JSON with their own copy of the traversal and response-array-joining logic. Consolidating that is what
makes "the same answers as the book" a structural guarantee instead of a convention.

---

## 1. `aifirstcontent` — content + TS core

### Content schema changes

Current example shape (from `book_content/ai-first-python-programming.json`):

```json
{ "title": "Hello World", "description": "...", "prompt": "Write a Hello World app",
  "response": "print(\"Hello, World!\")" }
```

Add an authored `id`. Two forms must be supported because **6 of the 38 existing examples use the
multi-`prompts` array form** rather than a single `prompt`/`response` pair:

```json
{ "id": "py-2-03", "title": "...", "prompt": "...", "response": "..." }

{ "id": "py-2-07", "title": "...", "prompts": [
    { "id": "py-2-07.1", "prompt": "...", "response": "..." },
    { "id": "py-2-07.2", "prompt": "...", "response": "..." } ] }
```

ID convention: `<booktag>-<chapter>-<seq>` with `booktag` ∈ {`py`, `java`}, zero-padded seq, and
`.N` suffixes for steps within a multi-prompt example. IDs are assigned once and never reused or
renumbered.

- `schema/content.schema.json` — JSON Schema for the whole book structure, `id` required, `response`
  accepted as `string | string[]` (the extension already normalizes arrays by joining on `\n`).
- CI check enforcing **global ID uniqueness** and ID-format validity across all books. This is the
  guard that keeps learner logs from silently corrupting.

### `src/` — the `@aifirst/content` package

- `types.ts` — `Book`, `Section`, `Chapter`, `Example`, `PromptStep`, `ExerciseId`.
- `loader.ts` — walk book JSON → flat `Exercise[]`; normalize `response: string[] → string`; derive
  `language` from filename (`*python* → python`, `*java* → java`), preserving the existing behavior in
  `AIFirstLanguageModelProvider.loadPromptsFromBooks()`.
- `matcher.ts` — lift the existing tiered algorithm verbatim from
  `AIFirstLanguageModelProvider.findMatchingPrompt()` / `searchEntries()`: language-scoped filter,
  then exact (case-insensitive, trimmed) → bidirectional partial → word-overlap fuzzy (>50%); and for
  unknown language, the python → java → other group fallthrough.
- `ids.ts` — parse/format/validate IDs, resolve unambiguous prefixes, order exercises for `next`.
- Unit tests pinning matcher behavior against all 38 examples, so the extension refactor is provably
  behavior-preserving.

### One-time authoring pass

Move `book_content/*.json` from the extension repo into `aifirstcontent/books/`, add `id` to all 38
examples and 6 multi-prompt sub-steps. Preserve the existing chapter/section titles exactly — the
book text references them.

> Note: chapters 4–12 (Java) and 4–10 (Python) currently contain **zero** examples. The CLI must
> handle empty chapters as a normal state, not an error. See Risks.

---

## 2. `aifirstcli` — the binary

### Layout

```
src/
  index.ts                 arg parsing + dispatch
  commands/{init,doctor,list,next,show,apply,done,progress,search,update,skill}.ts
  agents/                  one adapter per target, all behind a common interface
    claude.ts codex.ts antigravity.ts vscode.ts detect.ts
  skills/                  authored skill source, rendered per agent
    SKILL.md.tmpl  commands/*.md  rules/aifirst.md
  log/progress.ts          learner log read/write
  content/resolve.ts       embedded pack vs ~/.aifirst/content precedence
books/                     copied from @aifirst/content at build, embedded via --asset
install/{install.sh,install.ps1}
.github/workflows/release.yml
```

### Command surface

Learner-facing:

| Command | Behavior |
|---|---|
| `aifirst init [--yes] [--claude\|--codex\|--antigravity\|--vscode]` | Detect all agents, print findings, confirm once, install skills. Flags narrow the target set. |
| `aifirst doctor` | Report detected agents, installed skill versions + drift, content pack version, log location. |
| `aifirst list [book] [--chapter N]` | Browse books/chapters/exercises with completion marks. |
| `aifirst next` | Next incomplete exercise, **skipping chapters with no authored examples**. |
| `aifirst show <id>` | Print the canonical prompt and response. |
| `aifirst prompt <id>` | Print only the prompt (for pasting into any agent). |
| `aifirst apply <id> [--into <file>]` | Write the canonical response to disk; marks the exercise done (`via: apply`). |
| `aifirst done <id>` / `skip <id>` / `reset [id]` | Self-reported progress. |
| `aifirst progress [--format text\|json\|md]` | Percent complete over *authored* exercises, per book and chapter. |
| `aifirst update [--content]` | Self-update binary and/or refresh content pack. |
| `aifirst skill install\|check\|remove` | Manage skill bundles per agent (mirrors `neo4j-cli skill`). |

Agent-facing contract (stable, documented in the skill):

- `aifirst show <id> --format json` → `{id, title, language, prompt, response, chapter, book}`
- `aifirst search "<prompt text>" --format json [--language py|java]` → matched exercise, using the
  shared `matcher.ts`. This is how an agent resolves a prompt the learner typed from the page.
- `aifirst done <id> --via agent --agent claude` → record completion from a chat-only flow.

All read commands support `--format json`; every command exits non-zero with a machine-readable error
on stderr so agents can react.

### Learner log

`~/.aifirst/progress.json` (honoring `$XDG_STATE_HOME` when set; `%LOCALAPPDATA%\aifirst` on Windows):

```json
{ "version": 1,
  "content": { "pack": "1.3.0" },
  "exercises": {
    "py-2-03": { "status": "done", "at": "2026-08-07T17:40:00Z", "via": "apply" },
    "py-2-04": { "status": "done", "at": "...", "via": "agent", "agent": "claude" },
    "java-1-01": { "status": "skipped", "at": "..." } } }
```

Written atomically (temp file + rename) and merged on read, because the CLI and an agent subprocess
can write concurrently. Unknown IDs are retained rather than pruned, so a content downgrade never
destroys history. Plain JSON, not SQLite — a student should be able to read and hand-edit it.

---

## 3. Skill bundles — the four targets

One authored source in `src/skills/`, rendered into each agent's native layout. Verified paths:

| Target | Install location | Notes |
|---|---|---|
| **Claude Code** | `~/.claude/skills/aifirst/SKILL.md` | Auto-loads as `aifirst@skills-dir`. Add `commands/*.md` for `/aifirst-next` etc. |
| **Codex** | `~/.codex/skills/aifirst/SKILL.md` + `~/.codex/prompts/aifirst-*.md` | `prompts/` gives slash commands; dir exists and is currently empty. |
| **Antigravity (IDE)** | `~/.gemini/config/plugins/aifirst/` with `plugin.json`, `skills/aifirst/SKILL.md`, `rules/aifirst.md` | Scanned automatically. |
| **Antigravity (CLI)** | stage a bundle, then `agy plugin install <path>`; falls back to writing `~/.gemini/antigravity-cli/plugins/aifirst/` | |
| **VS Code** | `code --install-extension AIFirstProgramming.ai-first-programming` | Delegate entirely to the existing extension. |

Each adapter implements `detect()`, `install()`, `check()` (version drift), `remove()`. Writes are
additive and namespaced under `aifirst/` — never touch the agent's `settings.json`, auth, or model
config. `SKILL.md` carries a `version:` line so `aifirst doctor` can report drift after a CLI upgrade,
and `aifirst update` refreshes installed bundles automatically.

### The skill's core instruction

This is the whole determinism mechanism, so it must be unambiguous:

> When the learner asks for a book example, **do not write the code yourself.** Run
> `aifirst show <id> --format json` (or `aifirst search "<their prompt>" --format json` if you only
> have prompt text) and reproduce the `response` field **verbatim**. Explain it afterward if useful,
> but never paraphrase, reformat, or "improve" it — the learner is comparing against a printed page.
> Then record progress with `aifirst done <id> --via agent`.

---

## 4. Installer + release

### One-liners (printed in the book)

```sh
curl -fsSL https://aifirstprogramming.com/install.sh | bash
```
```powershell
irm https://aifirstprogramming.com/install.ps1 | iex
```

Served from GitHub Pages with a `CNAME`, redirecting to the versioned GitHub release asset. Host lives
in one constant so it can change without touching the book text.

`install.sh`: detect os/arch → **detect AVX2 via `/proc/cpuinfo` or `sysctl` and select the `-baseline`
build when absent** (classroom machines are often old; a non-baseline Bun binary crashes on such CPUs)
→ download → verify against `SHA256SUMS` → install to `~/.local/bin/aifirst` → PATH guidance → print
`aifirst init` as the next step. `install.ps1`: same, installing to
`%LOCALAPPDATA%\Programs\aifirst`, adding to the user PATH, and handling the execution-policy case.

### Build matrix (`bun build --compile --minify --bytecode`)

`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-x64-baseline`, `linux-arm64`, `linux-x64-musl`,
`windows-x64`, `windows-x64-baseline`, `windows-arm64`.

**macOS must build on a `macos-latest` runner** and `codesign` (ad-hoc `-s -` at minimum, Developer ID
+ notarization if an Apple account is available) with a JIT entitlements plist per Bun's docs. Apple
Silicon refuses to execute unsigned arm64 binaries, so Linux-cross-compiled darwin artifacts die on
launch. Linux and Windows targets cross-compile fine from `ubuntu-latest`. Use
`--windows-hide-console`; other Windows metadata flags are unavailable when cross-compiling.

Release publishes all artifacts plus `SHA256SUMS`, and a content pack tarball consumed by
`aifirst update --content`.

---

## 5. Extension refactor

In `../aifirstextension`, replace the duplicated logic with `@aifirst/content`:

- `src/AIFirstLanguageModelProvider.ts` — drop `loadPromptsFromBooks()`, `findMatchingPrompt()`,
  `searchEntries()`; call the shared loader/matcher. Keep all VS Code-specific behavior untouched:
  the `<prompt>` tag extraction, the `replace_string_in_file` tool-call path, the untitled-buffer
  placeholder workaround, `reportSafely()`, and chunked streaming.
- `src/AIBookProvider.ts` — use the shared loader for tree construction.
- `book_content/` — consume from the content package instead of holding the canonical copy.

Sequenced **after** the CLI ships, so a published extension isn't destabilized by an unproven API. The
matcher tests from the content package are the safety net; bump to 1.5.0 and verify the walkthrough
manually before publishing.

---

## Phasing

1. **`aifirstcontent`** — repo, schema, ID authoring pass over 38 examples, `@aifirst/content` with
   matcher tests.
2. **CLI core** — content resolution (embedded + refreshable), `list`/`show`/`prompt`/`next`,
   learner log, `progress`.
3. **Agent adapters** — Claude + Codex first (installed here, so testable), then Antigravity and
   VS Code; `init`, `doctor`, `skill install`.
4. **Release pipeline** — bun compile matrix, macOS signing, `install.sh`/`install.ps1`, Pages + CNAME.
5. **Extension refactor** onto `@aifirst/content`.
6. **Later:** opt-in `aifirst book-mode` local fake-model server for true zero-quota determinism.

## Verification

- **Content**: schema validation + ID-uniqueness CI check; matcher unit tests over all 38 examples;
  a golden test asserting every example's `response` round-trips byte-identically through
  loader → `show --format json` → `apply`.
- **CLI**: `bun test` for log merge/atomicity, ID prefix resolution, `next` correctly skipping empty
  chapters, and content-precedence (embedded vs `~/.aifirst/content`).
- **Agent adapters**: install into this machine's real Claude (2.1.224) and Codex (0.141.0), then
  confirm `claude plugin list` / `codex` sees the skill and that a fresh session asked for a book
  example shells out to `aifirst` and returns the byte-exact response. Antigravity needs a machine
  with it installed — its paths come from published docs, not local inspection.
- **Installer**: run `install.sh` in clean Linux and macOS containers/VMs asserting a working
  `aifirst --version`; run `install.ps1` on a clean Windows VM. Verify a `-baseline` binary is chosen
  on a CPU without AVX2 (or with AVX2 masked).
- **End-to-end**: fresh machine → curl one-liner → `aifirst init` → `aifirst next` → ask the agent for
  that exercise → response matches the printed book → `aifirst progress` shows it complete.

## Risks / open items

- **Content coverage is the binding constraint.** Only 38 examples exist, all in chapters 1–3; Java
  ch4–12 and Python ch4–10 are empty. The CLI is only as useful as the authored content, and
  `next`/`progress` must compute over authored exercises so a learner never sees a misleading "0 of
  22 chapters."
- **Antigravity paths are documentation-sourced**, not verified locally (not installed on this
  machine). Needs a real-machine test, and note it shares `~/.gemini` with Gemini CLI.
- **macOS signing** is a hard gate on Apple Silicon; confirm whether an Apple Developer account exists
  for proper notarization vs ad-hoc signing.
- **Binary size** ~55–90MB per target from the embedded Bun runtime. Acceptable (Claude Code's own
  binary is 282MB) but worth stating in the book's install section.
- **`irm | iex` execution policy** friction on locked-down Windows machines; `install.ps1` should
  detect and print the exact remediation.
- **The extension refactor touches a published product** (v1.4.0) — behavior-preserving tests first.
