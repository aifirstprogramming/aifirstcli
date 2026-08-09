/**
 * `aifirst diff <id> [--file <path>]` — compare a file against the book's code.
 *
 * This exists because an assistant kept reinventing it in the shell: dump the
 * canonical response through `--format json` and python3, write it to a temp file,
 * then `diff <(cat theirs) /tmp/...`. That works, but process substitution trips a
 * permission prompt, so the learner is asked to approve a shell command in the
 * middle of an exercise. Answering "does this match the book?" is squarely this
 * tool's job, so it is a subcommand and it is pre-approved.
 *
 * Records nothing. Comparing is not completing — see `aifirst run`.
 *
 * Exit code is 1 when the file differs, so a script can branch without parsing.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { exercisePath, resolve } from "@aifirst/content";
import type { Args } from "../cli";
import { formatFlag, numberFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import type { Step } from "../content/types";
import { finalResponse } from "../exercises";
import { CliError, bold, cyan, dim, glyph, green, json, out, red } from "../output";
import { condense, diffLines, normalize } from "../textdiff";

export function diff(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const id = args.positionals[0];
  if (!id) {
    throw new CliError(
      "diff needs an exercise id",
      "missing_argument",
      "Try: aifirst diff py-1-01            compares ./hello_world.py\n" +
        "     aifirst diff py-7-01 --file assert.py",
    );
  }

  const { content } = resolveContent();
  const hit = resolve(id, content);
  const example = hit.example;

  // Same step selection as `apply`: an explicit step, the addressed step, or the
  // final one for a whole multi-step example.
  const stepNumber = numberFlag(args, "step");
  let step: Step;
  if (stepNumber !== undefined) {
    const found = example.steps.find((s) => s.index === stepNumber);
    if (!found) {
      throw new CliError(
        `${example.id} has ${example.steps.length} step(s); there is no step ${stepNumber}`,
        "unknown_step",
      );
    }
    step = found;
  } else if (hit.kind === "step") {
    step = hit.step;
  } else {
    step = finalResponse(example);
  }

  // A second positional is accepted so `aifirst diff py-7-01 assert.py` works the
  // way anyone would expect from `diff`.
  const target = stringFlag(args, "file") ?? args.positionals[1] ?? exercisePath(example, step);
  const path = resolvePath(target);

  if (!existsSync(path)) {
    throw new CliError(
      `${target} does not exist`,
      "file_not_found",
      `Write the book's version with: aifirst apply ${step.id} --into ${target}`,
    );
  }

  const yours = normalize(readFileSync(path, "utf8"));
  const book = normalize(step.response);
  const identical = yours === book;
  const lines = identical ? [] : diffLines(yours, book);

  if (format === "json") {
    json({
      exerciseId: example.id,
      stepId: step.id,
      file: path,
      identical,
      // Only the differing lines: an agent comparing two files wants the answer,
      // not a copy of both.
      changes: lines
        .filter((l) => l.op !== "same")
        .map((l) => ({ op: l.op, line: l.yours ?? l.book, text: l.text })),
    });
    if (!identical) process.exitCode = 1;
    return;
  }

  out();
  if (identical) {
    out(`  ${green(glyph.done)} ${bold(target)} matches the book  ${dim(step.id)}`);
    out();
    return;
  }

  out(`  ${red(glyph.todo)} ${bold(target)} differs from the book  ${dim(step.id)}`);
  out();
  out(dim(`  ${red("-")} yours    ${green("+")} the book`));
  out();
  for (const entry of condense(lines)) {
    if (entry === "gap") {
      out(dim("       ⋮"));
      continue;
    }
    if (entry.op === "same") out(dim(`       ${entry.text}`));
    else if (entry.op === "removed") out(red(`  -    ${entry.text}`));
    else out(green(`  +    ${entry.text}`));
  }
  out();
  out(dim(`  ${cyan(glyph.arrow)} take the book's version: aifirst apply ${step.id} --into ${target} --force`));
  out();
  process.exitCode = 1;
}
