/**
 * Interactive confirmation.
 *
 * Deliberately refuses to prompt when stdin isn't a TTY. A learner running this
 * from a script, a CI job, or a piped installer would otherwise hang forever on a
 * question nobody can see — better to fail with an instruction to pass `--yes`.
 */

import { createInterface } from "node:readline/promises";
import { CliError, bold, dim, out } from "./output";
import { currentTuiSession } from "./tui/session";

let promptInterrupted = false;

export function consumePromptInterrupt(): boolean {
  const interrupted = promptInterrupted;
  promptInterrupted = false;
  return interrupted;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function confirm(question: string, hint: string): Promise<boolean> {
  const tui = currentTuiSession();
  if (tui) {
    const picked = await tui.choose(question, [
      { key: "yes", label: "Yes" },
      { key: "no", label: "No" },
    ]);
    if (!picked && tui.consumeInterrupt()) promptInterrupted = true;
    return picked?.kind === "choice" && picked.key === "yes";
  }
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
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      promptInterrupted = true;
      return false;
    }
    throw error;
  } finally {
    rl.close();
  }
}

export interface Choice {
  /** Short value a learner can also type, e.g. "py". */
  key: string;
  label: string;
}

export type ChoiceOrInput =
  | { kind: "choice"; key: string }
  | { kind: "input"; value: string };

/**
 * Numbered single-choice picker. Accepts the number or the key.
 *
 * Returns undefined on an empty answer so callers can treat "just pressed enter"
 * as "ask me later" rather than forcing a guess.
 */
export async function choose(question: string, choices: Choice[]): Promise<string | undefined> {
  const tui = currentTuiSession();
  if (tui) {
    const picked = await tui.choose(question, choices);
    if (!picked && tui.consumeInterrupt()) promptInterrupted = true;
    return picked?.kind === "choice" ? picked.key : undefined;
  }
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

      const byNumber = /^\d+$/.test(answer) ? Number(answer) : Number.NaN;
      if (!Number.isNaN(byNumber) && byNumber >= 1 && byNumber <= choices.length) {
        return choices[byNumber - 1].key;
      }
      const byKey = choices.find((c) => c.key.toLowerCase() === answer);
      if (byKey) return byKey.key;

      out(dim(`  Enter 1-${choices.length}, or press enter to decide later.`));
    }
    return undefined;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      promptInterrupted = true;
      return undefined;
    }
    throw error;
  } finally {
    rl.close();
  }
}

/** Numbered picker that also accepts free-form text for exercise lookup. */
export async function chooseOrInput(
  question: string,
  choices: Choice[],
  inputHint: string,
): Promise<ChoiceOrInput | undefined> {
  const tui = currentTuiSession();
  if (tui) {
    const picked = await tui.choose(question, choices, inputHint);
    if (!picked && tui.consumeInterrupt()) promptInterrupted = true;
    return picked;
  }
  if (!isInteractive()) return undefined;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    out();
    out(`  ${bold(question)}`);
    for (const [i, c] of choices.entries()) {
      out(`    ${bold(String(i + 1))}) ${c.label}`);
    }
    out();
    out(dim(`  ${inputHint}`));
    const raw = (await rl.question("  > ")).trim();
    if (raw === "") return undefined;

    if (/^\d+$/.test(raw)) {
      const byNumber = Number(raw);
      if (byNumber >= 1 && byNumber <= choices.length) {
        return { kind: "choice", key: choices[byNumber - 1].key };
      }
    }
    const byKey = choices.find((choice) => choice.key.toLowerCase() === raw.toLowerCase());
    if (byKey) return { kind: "choice", key: byKey.key };
    return { kind: "input", value: raw };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      promptInterrupted = true;
      return undefined;
    }
    throw error;
  } finally {
    rl.close();
  }
}
