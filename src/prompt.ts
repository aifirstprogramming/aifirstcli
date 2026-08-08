/**
 * Interactive confirmation.
 *
 * Deliberately refuses to prompt when stdin isn't a TTY. A learner running this
 * from a script, a CI job, or a piped installer would otherwise hang forever on a
 * question nobody can see — better to fail with an instruction to pass `--yes`.
 */

import { createInterface } from "node:readline/promises";
import { CliError, bold, dim, out } from "./output";

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

export interface Choice {
  /** Short value a learner can also type, e.g. "py". */
  key: string;
  label: string;
}

/**
 * Numbered single-choice picker. Accepts the number or the key.
 *
 * Returns undefined on an empty answer so callers can treat "just pressed enter"
 * as "ask me later" rather than forcing a guess.
 */
export async function choose(question: string, choices: Choice[]): Promise<string | undefined> {
  if (!isInteractive()) return undefined;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      out();
      out(`  ${bold(question)}`);
      for (const [i, c] of choices.entries()) {
        out(`    ${bold(String(i + 1))}) ${c.label}`);
      }
      out();
      const answer = (await rl.question("  > ")).trim().toLowerCase();
      if (answer === "") return undefined;

      const byNumber = Number.parseInt(answer, 10);
      if (!Number.isNaN(byNumber) && byNumber >= 1 && byNumber <= choices.length) {
        return choices[byNumber - 1].key;
      }
      const byKey = choices.find((c) => c.key.toLowerCase() === answer);
      if (byKey) return byKey.key;

      out(dim(`  Enter 1-${choices.length}, or press enter to decide later.`));
    }
    return undefined;
  } finally {
    rl.close();
  }
}
