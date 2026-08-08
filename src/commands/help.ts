/**
 * `aifirst help`.
 *
 * Written for someone on chapter 1 of their first programming book, so it leads
 * with the three commands that matter and keeps the rest short.
 */

import { bold, cyan, dim, out } from "../output";
import { INSTALL_HOST, VERSION } from "../version";

export function help(): void {
  out();
  out(`  ${bold("aifirst")} ${dim(VERSION)} — companion for the AI First book series`);
  out();
  out(`  ${bold("Getting started")}`);
  out(`    ${cyan("aifirst init")}              set up your AI tools with the book skills`);
  out(`    ${cyan("aifirst book")} ${dim("[py|java]")}      which book you're reading`);
  out(`    ${cyan("aifirst next")}              show your next exercise`);
  out(`    ${cyan("aifirst progress")}          how far you've got`);
  out();
  out(`  ${bold("Exercises")}`);
  out(`    ${cyan("aifirst run")} ${dim("<id>")}           write it, run it, record it`);
  out(`    ${cyan("aifirst show")} ${dim("<id>")}          the book's prompt and exact code`);
  out(`    ${cyan("aifirst list")} ${dim("[py|java]")}      browse books and chapters`);
  out(`    ${cyan("aifirst prompt")} ${dim("<id>")}        just the prompt, to paste into a chat`);
  out(`    ${cyan("aifirst apply")} ${dim("<id>")}         write the code without running it`);
  out(`    ${cyan("aifirst search")} ${dim('"<text>"')}     find the exercise for a prompt`);
  out();
  out(`  ${bold("Progress")}`);
  out(`    ${cyan("aifirst done")} ${dim("<id>")}          mark an exercise complete`);
  out(`    ${cyan("aifirst skip")} ${dim("<id>")}          skip one`);
  out(`    ${cyan("aifirst reset")} ${dim("<id>|--all")}   forget progress`);
  out();
  out(`  ${bold("Setup")}`);
  out(`    ${cyan("aifirst doctor")}            check everything is wired up`);
  out(`    ${cyan("aifirst skill")} ${dim("install|check|remove")}`);
  out(`    ${cyan("aifirst update")} ${dim("[--content] [--check]")}`);
  out();
  out(`  ${bold("Options")}`);
  out(`    ${dim("--format text|json|md")}     json is the machine-readable contract`);
  out(`    ${dim("--yes")}                     skip confirmation in init`);
  out(`    ${dim("--claude --codex --antigravity --antigravity-cli --vscode")}`);
  out(`    ${dim("                          target specific tools")}`);
  out();
  out(`  Exercise ids look like ${bold("py-2-06")} or ${bold("java-3-05")}.`);
  out(`  ${dim(`Docs: ${INSTALL_HOST}`)}`);
  out();
}
