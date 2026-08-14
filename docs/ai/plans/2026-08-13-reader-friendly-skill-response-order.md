---
feature_id: reader-friendly-skill-response-order
date: 2026-08-13
shipped: true
---

# Reader-friendly skill response order

I read the generated skill prose in `src/skills/content.ts` directly rather
than trusting my memory of it. Two defects showed up in four places: the
main flow told the agent to report output before code, and the Gotchas
bullet, both slash commands, and `antigravityRules()` all implied the stored
`explanation` field is book text rather than AI First content library
material. `antigravityRules()` used different wording than the other three
("wording matches the book" instead of "the book's too"), which is exactly
the kind of variant a plain find-and-replace on one phrase would miss.

I chose to fix all four surfaces in the same source file rather than
splitting the work, since `src/skills/content.ts` is the single generator
for `SKILL.md`, both slash commands, and the Antigravity rules. There was no
real alternative layer to consider: the content itself lives in
`aifirstcontent`, but the reader-facing instructions about how to present it
are template strings here, out of that package's scope.

The new contract is the same everywhere: present the code first, then the
stored explanation under the literal label `Explanation:`, then the real
program output, and only report completion after the output and only when
`recorded` is true or the exercise was already recorded. The canonical-code
rule (the `response` field is verbatim, compared against the printed page)
stays exactly as it was; only the explanation-provenance language changed.

I verified this with a mutation test rather than assuming the new assertions
would catch a regression. `test/agents.test.ts` reproduces the old
output-first main-flow wording as an in-memory string fixture and runs the
exact ordering assertion from the fixed test against it, asserting that it
throws. It does, because the old sentence never mentions an ordering token
for the explanation at all. I also added a cross-surface absence check that
scans `skillMarkdown()`, every `commandFiles()` body, and `antigravityRules()`
for all three forbidden phrases together, so a fix that lands correctly in
three surfaces and misses a fourth still fails.

`src/commands/run.ts`'s own terminal formatter, which renders Code → Output
→ Explanation for the CLI's own non-agent output, is untouched; `git diff`
confirms zero changes to that file. `bun test test/agents.test.ts` passes 32
of 32, and `bun install --frozen-lockfile && bun run check` passes the full
gate.
