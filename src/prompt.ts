/**
 * Interactive confirmation.
 *
 * Deliberately refuses to prompt when stdin isn't a TTY. A learner running this
 * from a script, a CI job, or a piped installer would otherwise hang forever on a
 * question nobody can see — better to fail with an instruction to pass `--yes`.
 */

import { createInterface } from "node:readline/promises";
import { CliError, bold } from "./output";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function confirm(question: string, hint: string): Promise<boolean> {
  if (!isInteractive()) {
    throw new CliError(
      "Cannot ask for confirmation: this isn't an interactive terminal",
      "confirmation_required",
      hint,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${bold(question)} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
