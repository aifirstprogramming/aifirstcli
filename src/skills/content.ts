/**
 * The authored skill text, rendered into each agent's native layout.
 *
 * Kept as template literals in TypeScript rather than loose .md files so it is
 * unconditionally bundled into the compiled binary — `aifirst init` must work on
 * a machine with no network and no files beside the executable.
 *
 * This text is the entire determinism mechanism. An agent that paraphrases the
 * response, reformats it, or writes its own version defeats the point of the
 * book, so the instruction to reproduce output verbatim is stated first, stated
 * plainly, and repeated in the gotchas.
 */

import { VERSION } from "../version";

export const SKILL_NAME = "aifirst";

const DESCRIPTION =
  "Serves the exact code examples printed in the AI First book series (Python and Java) via the `aifirst` CLI, " +
  "and records a learner's progress. Use when the user asks for a book example or exercise, pastes a prompt from " +
  "an AI First book, asks what exercise comes next, asks about their progress through the book, or asks to mark an " +
  "exercise complete. Skip for general Python or Java questions unrelated to the books.";

/** Body shared by every target, without frontmatter. */
function body(): string {
  return `# AI First book companion

The AI First books print a prompt and the exact code that prompt produces. Readers
work through them by typing the prompt into an AI assistant and comparing what they
get against the page.

Your job is to hand back **the book's canonical answer**, not your own attempt at
the exercise.

## The rule

Do not write the code yourself. Fetch it from the \`aifirst\` CLI and reproduce it
**verbatim** — same characters, same spacing, same names, same order.

\`\`\`bash
aifirst show py-2-06 --format json      # by exercise id
aifirst search "Write a Hello World app" --format json   # by prompt text
\`\`\`

Both print JSON with a \`steps\` array. Each step has a \`prompt\` and a
\`response\`. The \`response\` field is the code from the book. Emit it exactly as
given. Explain it afterwards if that helps the learner, but never edit it.

If the learner has already written their own attempt, show them the book's version
for comparison rather than overwriting their file.

## Commands

| Command | Use |
| --- | --- |
| \`aifirst next --format json\` | The learner's next unfinished exercise. |
| \`aifirst show <id> --format json\` | Canonical prompt(s) and response(s). |
| \`aifirst search "<prompt>" --format json\` | Find the exercise matching prompt text. |
| \`aifirst list [py\\|java] --format json\` | Browse books, chapters, exercises. |
| \`aifirst apply <id> --into <file>\` | Write the canonical response to a file (records progress). |
| \`aifirst done <id> --via agent --agent <you>\` | Record completion after a chat walkthrough. |
| \`aifirst progress --format json\` | Their ledger so far. |

Exercise ids look like \`py-2-06\` or \`java-3-05\`; \`py-2-06.2\` addresses step 2
of a multi-step exercise.

## Workflows

**They name an exercise** ("show me py-2-06", "let's do chapter 2 exercise 6")
Run \`aifirst show <id> --format json\`. Present the prompt, then the response
verbatim. Offer to write it with \`aifirst apply\`.

**They paste a prompt from the book**
Run \`aifirst search "<their text>" --format json\`. On a hit, give that exercise's
response verbatim. On \`{"match": null}\`, say no book example matches and answer
normally — do not invent an exercise id.

**They ask what's next** ("where was I", "what should I do now")
Run \`aifirst next --format json\`, show the exercise's prompt, and let them try it
before revealing the response.

**They finish an exercise in chat**
Run \`aifirst done <id> --via agent --agent <your name>\` so their ledger reflects
it even though no file was written.

**A multi-step exercise**
\`steps\` is ordered and progressive — each step modifies the previous result.
Walk through them in order. The last step's response is the finished program.

## Gotchas

- **Verbatim means verbatim.** No renamed variables, no added comments, no
  reformatting, no "improved" version, no switching quote style. The learner is
  diffing against printed pages.
- **Python and Java have separate exercises.** Pass \`--language py\` or
  \`--language java\` to \`search\` when you know which book they're reading;
  otherwise the match may come from the other book.
- **\`aifirst show\` does not record progress.** Only \`apply\` and \`done\` do.
  Viewing an exercise is not completing it.
- **Never run \`aifirst reset --all\`** unless the learner explicitly asks to wipe
  their progress. It clears their whole log.
- **Don't overwrite their work.** \`aifirst apply\` refuses to clobber an existing
  file; do not add \`--force\` on their behalf.
- If \`aifirst\` is missing, point them at
  \`curl -fsSL https://aifirstprogramming.com/install.sh | bash\` rather than
  reconstructing examples from memory — you will get them subtly wrong.
`;
}

/** SKILL.md with YAML frontmatter, the format all three agents read. */
export function skillMarkdown(): string {
  return `---
name: ${SKILL_NAME}
description: ${DESCRIPTION}
version: ${VERSION}
---

${body()}`;
}

/** Parse the `version:` line back out, for drift detection in `aifirst doctor`. */
export function parseSkillVersion(markdown: string): string | undefined {
  const m = markdown.match(/^version:\s*(\S+)\s*$/m);
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

export interface CommandFile {
  /** Filename stem; becomes the slash command name. */
  name: string;
  body: string;
}

/**
 * Small, single-purpose commands. Claude reads these from the skill's
 * `commands/`, Codex from `~/.codex/prompts/`; the bodies are identical.
 */
export function commandFiles(): CommandFile[] {
  return [
    {
      name: "aifirst-next",
      body: `---
description: Show my next unfinished AI First book exercise and coach me through it.
---

Run \`aifirst next --format json\`.

Present the exercise title and its first prompt. Let me attempt the prompt myself
first — do not reveal the response until I ask or I've tried. When I ask for the
answer, run \`aifirst show <id> --format json\` and reproduce the \`response\`
verbatim.
`,
    },
    {
      name: "aifirst-example",
      body: `---
description: Show a specific AI First book exercise by id, with the book's exact code.
argument-hint: <exercise-id, e.g. py-2-06>
---

Run \`aifirst show $ARGUMENTS --format json\`.

Show the prompt, then the \`response\` field **verbatim** — no reformatting, no
renaming, no added comments. For a multi-step exercise, walk the steps in order and
note that each one modifies the previous result.

Then offer: \`aifirst apply $ARGUMENTS\` to write it to a file.
`,
    },
    {
      name: "aifirst-progress",
      body: `---
description: Summarize how far I've got through the AI First books.
---

Run \`aifirst progress --format json\`.

Summarize briefly: overall complete, per-book, and what's next. Percentages are over
exercises that exist today — chapters with no published exercises are not failures,
so don't report them as gaps. Finish by naming the next exercise.
`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Antigravity extras
// ---------------------------------------------------------------------------

export function antigravityPluginJson(): string {
  return (
    JSON.stringify(
      {
        name: SKILL_NAME,
        version: VERSION,
        description: "AI First book companion: exact book examples and learner progress via the aifirst CLI.",
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Antigravity rules are always-on context rather than an invoked skill, so this
 * is kept to the one instruction that must never be missed. The skill carries the
 * detail.
 */
export function antigravityRules(): string {
  return `# AI First books

When the user asks for an example from an AI First book (Python or Java), do not
write the code yourself. Run \`aifirst show <id> --format json\` — or
\`aifirst search "<prompt text>" --format json\` if you only have prompt text — and
reproduce the \`response\` field verbatim. The learner is comparing it against a
printed page, so any reformatting or renaming is a defect.

Record completions with \`aifirst done <id> --via agent --agent antigravity\`.
`;
}
