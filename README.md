# aifirst

Companion CLI for the [AI First](https://aifirstprogramming.com) Apress book series.

The books print a prompt and the exact code it produces. This CLI installs a skill into whichever AI
tools you already use, so that when you ask for a book example you get **the book's answer** —
character for character — instead of whatever a model generates today. It also keeps a private log of
which exercises you've done.

## Install

```sh
curl -fsSL https://aifirstprogramming.com/install.sh | bash
```

<!-- The scripts under install/ are the source of truth; the website repo
     (aifirstprogramming/aifirstwebsite) serves copies of them from static/. -->


```powershell
irm https://aifirstprogramming.com/install.ps1 | iex
```

Then:

```sh
aifirst init      # sets up the AI tools it finds, and asks which book you're reading
aifirst next      # your next exercise
aifirst run <id>  # write the book's code, run it, record it
```

Nothing else is required — no Node, no Python, no JVM. The binary is self-contained and ships with all
the book content inside it, so it works offline on first run.

## Supported tools

| Tool | What gets installed | Where |
| --- | --- | --- |
| Claude Code | skill + slash commands | `~/.claude/skills/aifirst/` |
| Codex | skill + prompt commands | `~/.codex/skills/aifirst/`, `~/.codex/prompts/` |
| Antigravity (IDE) | plugin bundle | `~/.gemini/config/plugins/aifirst/` |
| Antigravity CLI (`agy`) | plugin bundle | `~/.gemini/antigravity-cli/plugins/aifirst/` |
| VS Code | the AI First extension | Marketplace |

`init` detects what you have, shows you, asks once, and installs into all of it.

Skill files are additive and confined to an `aifirst`-named directory per tool. `init` **also**
pre-approves the everyday `aifirst` commands, which is the one thing written outside those
directories — without it you approve a prompt for every step of every exercise:

| Tool | Allowlist written to |
| --- | --- |
| Claude Code | `~/.claude/settings.json` → `permissions.allow` (merged; a `.aifirst-backup` is written first) |
| Codex | `~/.codex/rules/default.rules` (a marker-delimited block) |
| Antigravity | not writable — `doctor` tells you to add `command(aifirst)` to its Allow list |

`aifirst init` and `aifirst skill install` both set this up, so an upgrade (which refreshes skills
through `skill install`) keeps it current. Only the reading and recording commands are allowlisted.
**`reset`, `skill` and `update` deliberately keep prompting**, so an assistant that misreads an instruction can't wipe your ledger or replace the
binary without you saying yes. Pass `--no-permissions` to skip this entirely, and
`aifirst skill remove` reverses both the files and the allowlist. Your choice to skip is remembered, so
`doctor` won't nag. No model configuration or credential is ever touched.

`aifirst doctor` reports per tool whether commands are pre-approved, and **exits non-zero if a tool
with the skill installed will still prompt** — a setup that works but interrupts you constantly is not
a healthy one.

## Commands

```
aifirst init [--yes] [--no-permissions] [--claude|--codex|--antigravity|--vscode]
aifirst book [py|java|all]          which book you're reading
aifirst next                        your next unfinished exercise, in your book
aifirst run <id> [--into <file>]    write the code, run it, record it
aifirst show <id>                   the book's prompt and exact code
aifirst list [py|java] [--chapter N]
aifirst prompt <id>                 just the prompt, to paste into a chat
aifirst apply <id> [--into <file>]  write the code without running it
aifirst search "<prompt text>"      find the exercise for a prompt
aifirst done|skip <id>              record progress by hand
aifirst reset <id>|--all
aifirst progress [--format text|json|md]
aifirst doctor
aifirst skill install|check|remove
aifirst update [--content] [--check]
```

Most commands take `--book <tag>` or `--all` to override the book you picked.

Exercise ids look like `py-2-06` or `java-3-05`. `py-2-06.2` addresses step 2 of a multi-step exercise.
Unambiguous prefixes work: `aifirst show py-1`.

### For agents

`--format json` is a stable contract, and it's what the installed skills use:

```sh
aifirst run py-2-06 --format json                        # write, run, record — the main one
aifirst show py-2-06 --format json                       # canonical prompt + response
aifirst search "Write a Hello World app" --format json   # resolve prompt text to an exercise
aifirst next --format json                               # may return needsBookChoice
```

Errors also render as JSON (on stderr) when `--format json` is set, and every command exits non-zero
on failure, so an agent can branch on the result rather than parse prose.

## How determinism works

The skill instructs the agent not to write the code itself, but to call `aifirst run` (or `show`) and
reproduce the `response` field verbatim. The answer therefore comes from the content pack, not from a
model — identical on every tool, every machine, and every run.

The skill is also explicit that the agent must not record completion itself. It can't honestly claim
an exercise is done, because only `run` records, and only when the program exits cleanly.

The matching that turns a prompt into a response lives in
[`@aifirst/content`](https://github.com/aifirstprogramming/aifirstcontent) and is shared with the VS
Code extension, so both surfaces resolve a given prompt the same way by construction rather than by
convention.

## What "done" means

An exercise is complete when **the program actually ran**. `aifirst run` writes the book's code,
executes it, and records it only on a clean exit. Neither `show` nor `apply` records anything: reading
a prompt or dropping a file on disk isn't doing the exercise, and a ledger that says otherwise is
worthless to the learner. `aifirst done <id>` remains for exercises you did by hand, in VS Code, or
without a runtime installed.

Eleven exercises read input. Those carry sample input in the content pack, so they run to completion
unattended — an assistant can't type into a running program, and Claude Code's `!` prefix
[doesn't attach an interactive stdin](https://github.com/anthropics/claude-code/issues/47103). Run one
from a real terminal and you type the values yourself instead.

## Your learner log

Plain JSON at `~/.aifirst/progress.json` (`$XDG_STATE_HOME/aifirst` if set,
`%LOCALAPPDATA%\aifirst` on Windows). Read it, edit it, copy it between machines, delete it. Your book
choice lives beside it in `config.json`, so resetting progress doesn't lose it.

It's a personal ledger, not an assessment — there's no verification and nothing to defend against
tampering.

Progress is scoped to the book you're reading, so a Python reader sees a denominator they can
actually finish rather than one inflated by a book they don't own. `aifirst book` switches; `--all`
shows everything. `next` never crosses out of your book — finish one and it says so, and offers the
others.

Percentages count **authored** exercises only. Both books have chapters written ahead of their
examples; counting those would tell you you're 15% done when you've finished everything that exists.

## Content

The books ship inside the binary, and `aifirst update --content` pulls a newer pack into
`~/.aifirst/content/` when one is published. A downloaded pack is validated through the same strict
loader the CLI uses before it's put in place, and is only ever preferred when strictly newer — so a
bad download can't leave you unable to see your exercises, and content fixes reach readers without a
new CLI release.

Current coverage is 38 exercises: chapters 1–3 of both books. Later chapters exist but have no
examples authored yet.

## Development

```sh
bun install
bun run check          # sync check + typecheck + tests
bun test
bun run build:local    # a binary for this machine, into ./bin
bun run build          # all non-darwin release targets
```

`@aifirst/content` is pinned to a tag of
[`aifirstcontent`](https://github.com/aifirstprogramming/aifirstcontent), so a fresh clone builds with
nothing else checked out. To work on content and the CLI together, link a local checkout:

```sh
cd ../aifirstcontent && bun link
cd -                 && bun link @aifirst/content
```

`bun run sync-content` copies the package's books into `books/` and regenerates the embedded module;
both are committed so a release is reproducible from a single commit. Bumping the content pin means
updating the dependency tag and re-running `sync-content`.

Note the `paths` entry in `tsconfig.json`: the package is installed from git and ships TypeScript
source with no built `dist`. Bun finds it through the package's `bun` export condition, but tsc
doesn't understand that condition and would otherwise resolve the import to `any` — passing the
typecheck while checking nothing.

Tests never touch a real config: `AIFIRST_HOME_OVERRIDE` and `AIFIRST_STATE_DIR` redirect every path,
and the end-to-end suite runs the CLI as a subprocess in a temp sandbox. Use the same variables to try
things by hand:

```sh
AIFIRST_HOME_OVERRIDE=/tmp/fakehome AIFIRST_STATE_DIR=/tmp/fakestate bun run src/index.ts init --claude
```

### Releasing

Tag `vX.Y.Z`. The release workflow cross-compiles Linux and Windows on Ubuntu, builds and codesigns
macOS on a macOS runner, and publishes nine artifacts plus `SHA256SUMS`.

Two things are easy to get wrong here:

- **macOS must be built on macOS.** Apple Silicon refuses to execute an unsigned arm64 binary, so a
  Linux-cross-compiled darwin artifact dies on launch. The workflow ad-hoc signs with the JIT
  entitlements Bun requires; set `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD` and
  `MACOS_SIGN_IDENTITY` to sign with a Developer ID instead.
- **Artifact names are a three-way contract** between `src/targets.ts`, `src/platform.ts` and
  `install/install.sh`. `test/platform.test.ts` keeps them in agreement. The `-baseline` variants exist
  for x64 CPUs without AVX2 (which Bun's default build requires and which crash on it) and `-musl` for
  Alpine; both the installer and `aifirst update` detect these, so a learner is never upgraded onto a
  binary that won't start.

## Verification notes

- Claude Code and Codex adapters were developed and tested against real installations.
- **Antigravity paths come from Google's published documentation, not local inspection** — they need a
  test on a machine with Antigravity installed. Note it shares `~/.gemini` with the Gemini CLI.
- The Java filename derivation (naming the file after the public class so `javac` accepts it) is unit
  tested, but has not been run through a real JDK.
