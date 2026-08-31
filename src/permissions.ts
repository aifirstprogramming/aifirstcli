/**
 * The commands `aifirst init` asks each agent to pre-approve.
 *
 * Without this a learner approves a prompt for every single call, which defeats
 * the point of the tool. It is also the one place this CLI writes outside its own
 * directories, so the list is deliberately narrow.
 *
 * **What is left off matters more than what is on.** `reset` erases a learner's
 * whole ledger, `skill` rewrites agent files, `update` replaces the binary. Those
 * keep prompting, so an assistant that misreads an instruction cannot destroy
 * anything without a human saying yes.
 */

/** Subcommands safe for an assistant to run unattended. */
export const ALLOWED_COMMANDS = [
  "show",
  "prompt",
  "next",
  "list",
  "search",
  "progress",
  "doctor",
  "book",
  "run",
  "apply",
  // Reads a file and compares it to the book. Added because without it an
  // assistant builds a shell pipeline to do the same thing, and process
  // substitution puts an approval prompt in the middle of an exercise.
  "diff",
  // Shows or moves the bookmark. Writes only that, never a completion.
  "at",
  "done",
  "skip",
] as const;

/** Deliberately excluded, documented so the reasoning survives. */
export const WITHHELD_COMMANDS: Record<string, string> = {
  reset: "clears the learner's progress",
  "book-mode": "rewrites agent configuration",
  serve: "opens a local socket",
  skill: "rewrites agent configuration",
  update: "replaces the binary",
  init: "writes to agent configuration",
  dependencies: "can install third-party packages",
  deps: "can install third-party packages",
};

/** Claude Code permission entries, e.g. `Bash(aifirst show:*)`. */
export function claudeEntries(command = "aifirst"): string[] {
  return [
    ...ALLOWED_COMMANDS.map((c) => `Bash(${command} ${c}:*)`),
    `Bash(${command} replay execute:*)`,
  ];
}

export const CODEX_BEGIN = "# >>> aifirst >>>";
export const CODEX_END = "# <<< aifirst <<<";

/**
 * Codex execpolicy rules, in Starlark.
 *
 * Wrapped in markers so the block can be replaced or removed without disturbing
 * rules the learner wrote themselves.
 */
export function codexRuleBlock(): string {
  const rules = ALLOWED_COMMANDS.map(
    (c) =>
      `prefix_rule(\n` +
      `    pattern = ["aifirst", "${c}"],\n` +
      `    decision = "allow",\n` +
      `    justification = "AI First book companion: reads book content and records the learner's own progress",\n` +
      `)`,
  ).join("\n");

  return [
    CODEX_BEGIN,
    "# Added by `aifirst init`. Remove with `aifirst skill remove`, or delete this block.",
    "# Destructive aifirst commands (reset, skill, update) are deliberately absent so",
    "# they still ask before running.",
    rules,
    CODEX_END,
  ].join("\n");
}

/** Antigravity's documented allowlist syntax, for the manual instruction. */
export const ANTIGRAVITY_ALLOW_ENTRY = "command(aifirst)";
