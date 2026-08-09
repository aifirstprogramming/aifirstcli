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

## Two rules

**1. Do not write the code yourself.** Fetch it from the \`aifirst\` CLI and
reproduce it **verbatim** — same characters, same spacing, same names, same order.

**2. Do not mark anything done yourself.** \`aifirst run\` writes the file, runs the
program, and records the exercise only if it actually ran. That is what "done"
means here. Never call \`aifirst done\` on your own initiative.

## The main flow

\`\`\`bash
aifirst run py-2-06 --format json
\`\`\`

One command: it writes the book's code to a sensibly named file, executes it, and
records the exercise on success. Report the program's real output, then give the
code. Do not tell the learner an exercise is complete unless \`recorded\` is true or
it was already recorded.

To show code without running it, use \`aifirst show <id> --format json\`. It returns
a \`steps\` array; each step has a \`prompt\` and a \`response\`, and \`response\` is
the code from the book. Emit it exactly as given.

## Which book?

Readers own one book of a growing series. Before the first exercise, run
\`aifirst next --format json\`. If it returns \`"needsBookChoice": true\`, **ask the
learner which book they are reading** and record it:

\`\`\`bash
aifirst book py      # or: aifirst book java
\`\`\`

Never guess, and never hand them an exercise from a book they may not own.

## Commands

| Command | Use |
| --- | --- |
| \`aifirst next --format json\` | Their next unfinished exercise, within their book. |
| \`aifirst run <id> --format json\` | Write it, run it, record it. The main one. |
| \`aifirst show <id> --format json\` | Canonical prompt(s) and response(s); records nothing. |
| \`aifirst search "<prompt>" --format json\` | Find the exercise matching prompt text. |
| \`aifirst list [py\|java] --format json\` | Browse books, chapters, exercises. |
| \`aifirst apply <id> --into <file>\` | Write the code without running it. |
| \`aifirst diff <id> [file] --format json\` | Does their file match the book? |
| \`aifirst at [<id>]\` | Show or move where they are in the book. |
| \`aifirst progress --format json\` | Their ledger so far. |
| \`aifirst book <tag>\` | Set or switch which book they are reading. |

Exercise ids look like \`py-2-06\` or \`java-3-05\`; \`py-2-06.2\` addresses step 2 of
a multi-step exercise.

## Workflows

**They ask to work in a particular chapter** ("let's do chapter 7")
\`aifirst at <first id in that chapter>\`, then \`aifirst next\`. The bookmark
stays there, so asking what is next later continues in that chapter rather than
jumping back.

**They ask what is next** ("where was I", "what should I do now")
\`aifirst next --format json\`. Show the prompt and let them try it themselves
before revealing the book's answer.

**They name an exercise** ("show me py-2-06", "let's do chapter 2 exercise 6")
\`aifirst run <id> --format json\`, then present the output and the exercise's
stored \`explanation\`. If
they only want to look at it, use \`show\`.

**They paste a prompt from the book**
\`aifirst search "<their text>" --format json\`. On a hit, use that exercise. On
\`{"match": null}\`, say no book example matches and answer normally — do not invent
an exercise id.

**A multi-step exercise**
\`steps\` is ordered and progressive: each step modifies the previous result. Walk
them in order. \`run\` executes the final step, which is the finished program.

**They finish a book**
\`next\` returns \`"complete": true\` with the book named. Congratulate them, then
offer the books listed in \`otherBooks\` via \`aifirst book <tag>\`.

**\`run\` fails with \`needs_interactive_run\`**
The exercise reads input and no terminal is attached. Ask the learner to run it
themselves so they can type the answers:

    !aifirst run <id>

The leading \`!\` runs it in their own shell and shows you the output.

## Gotchas

- **Verbatim means verbatim.** No renamed variables, no added comments, no
  reformatting, no "improved" version, no switching quote style. The learner is
  comparing against a printed page.
- **The explanation is the book's too.** Every exercise ships an \`explanation\`
  with a \`summary\` and line-by-line notes. Present those; do not write your own
  walkthrough alongside or instead. They are the same words the VS Code extension
  shows, and that agreement is the point — the extension has no model and cannot
  write one. Answer follow-up questions freely; just do not replace the canonical
  text with a fresh paraphrase.
- **Only \`run\` records progress.** \`show\` and \`apply\` deliberately do not.
  Reading a prompt or writing a file is not completing an exercise, and a ledger
  that claims otherwise is worthless to the learner.
- **Report what actually happened.** If the program failed, say so and help them
  fix it. Never describe an exercise as done because the code looks correct.
- **Python and Java have separate exercises.** Pass \`--language py\` or
  \`--language java\` to \`search\` when you know which book they are reading.
- **Never run \`aifirst reset --all\`** unless the learner explicitly asks to wipe
  their progress; it clears their whole log. It will ask for approval — do not
  approve it on their behalf.
- **\`next\` resumes where they are, not from the earliest gap.** A bookmark
  advances as exercises are recorded, so someone working in chapter 7 is offered
  chapter 7 next even with gaps behind them. When it passes over earlier
  unfinished exercises it says how many, and \`--earliest\` goes back for them.
  If they want to read a different chapter, move the bookmark with
  \`aifirst at <id>\` — do **not** skip the exercises in between to get there.
  Skipping is a claim about those exercises and it goes in their ledger; the
  bookmark says nothing about them.
- **Compare with \`aifirst diff\`, never with a shell pipeline.** To check whether
  a learner's file matches the book, run \`aifirst diff <id> <file>\`. It is
  pre-approved and reports the differing lines. Reaching for \`diff\`,
  \`<(...)\`, a temp file, or piping \`show --format json\` through python to
  reconstruct the code all do the same job less well, and process substitution
  triggers a permission prompt in the middle of an exercise.
- **Consecutive exercises often share a filename, and that is handled.** Whole
  chapters evolve one file — Python 7 builds a single test file across five
  exercises, and several Java exercises all declare \`public class Thermostat\`,
  which javac requires to live in \`Thermostat.java\`. \`aifirst run\` replaces its
  own previous output automatically and tells you which exercise it replaced. Do
  not delete the file first, and do not invent \`--into\` names to dodge the
  collision; the learner ends up with scattered copies and loses the thread of
  the chapter.
- **Do not overwrite their work.** \`run\` and \`apply\` refuse to replace a file
  whose contents differ. Do not add \`--force\` on their behalf.
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

If it reports \`"needsBookChoice": true\`, ask me which book I'm reading and set it
with \`aifirst book <tag>\` before going further.

Present the exercise title and its first prompt. Let me attempt the prompt myself
first — do not reveal the book's answer until I ask or I've tried. When I ask for it,
run \`aifirst run <id> --format json\`, which writes the code, runs it, and records
the exercise. Show me the real output, then the book's explanation.
`,
    },
    {
      name: "aifirst-example",
      body: `---
description: Run a specific AI First book exercise by id, with the book's exact code.
argument-hint: <exercise-id, e.g. py-2-06>
---

Run \`aifirst run $ARGUMENTS --format json\`.

That writes the book's code, executes it, and records the exercise only if it ran.
Show me the program's actual output, then the code **verbatim** — no reformatting, no
renaming, no added comments — followed by the exercise's own \`explanation\` rather
than one you write. For a multi-step exercise, note that
each step modifies the previous result.

If it fails with \`needs_interactive_run\`, the exercise reads input: ask me to run
\`!aifirst run $ARGUMENTS\` myself so I can type the answers.
`,
    },
    {
      name: "aifirst-progress",
      body: `---
description: Summarize how far I've got through the AI First books.
---

Run \`aifirst progress --format json\`.

Summarize briefly: how far through my book I am, and what's next. Percentages cover
the exercises published today and are scoped to the book I'm reading — chapters with
no published exercises are not failures, so don't report them as gaps. Finish by
naming the next exercise.
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
write the code yourself. Run \`aifirst run <id> --format json\` — which writes the
book's code, runs it, and records the exercise only if it ran — or
\`aifirst show <id> --format json\` if they only want to see it. Reproduce the
\`response\` field verbatim; the learner is comparing it against a printed page, so
any reformatting or renaming is a defect. Each step also carries an
\`explanation\` — present that rather than writing your own, so the wording matches
the book and the VS Code extension.

Never mark an exercise done yourself: \`aifirst run\` records it. If
\`aifirst next\` reports \`needsBookChoice\`, ask which book they are reading and
set it with \`aifirst book <tag>\` rather than guessing.
`;
}
