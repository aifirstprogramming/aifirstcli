/**
 * `aifirst apply <id> [--into <file>]`.
 *
 * Writes the book's canonical response and any required project scaffold. No
 * model is involved, so the learner's files match the stored checkpoint.
 *
 * Deliberately does **not** record progress — see `aifirst run`, which writes and
 * then executes, and records only when the program actually runs. Marking an
 * exercise done for writing a file was the original behaviour and it let an
 * assistant tick off an exercise it had neither written nor run.
 *
 * Refreshes only unchanged output that AI First previously generated. A learner's
 * own attempt is left alone unless they explicitly pass `--force`.
 */

import { resolve } from "@aifirst/content";
import type { Args } from "../cli";
import { boolFlag, formatFlag, numberFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import { finalResponse } from "../exercises";
import type { Step } from "../content/types";
import { CliError, bold, dim, glyph, green, json, out } from "../output";
import { defaultExercisePath } from "../workspace";
import { prepareExerciseFiles } from "./run";


export function apply(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const id = args.positionals[0];
  if (!id) {
    throw new CliError("apply needs an exercise id", "missing_argument", "Try: aifirst apply py-1-01");
  }

  const { content } = resolveContent();
  const hit = resolve(id, content);
  const example = hit.example;

  // Which response to write: an explicit step, the addressed step, or — for a
  // whole multi-step example — the final one, since the steps are progressive
  // and earlier ones are half-built versions of the same program.
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

  const target = stringFlag(args, "into");

  // `--into -` writes to stdout, for piping without touching the filesystem.
  if (target === "-") {
    process.stdout.write(step.response.endsWith("\n") ? step.response : step.response + "\n");
    return;
  }

  const prepared = prepareExerciseFiles(content, example, step, {
    into: target ?? defaultExercisePath(content, example, step),
    force: boolFlag(args, "force"),
  });
  const { path, wrote, scaffoldFiles } = prepared;

  if (format === "json") {
    json({
      applied: { exerciseId: example.id, stepId: step.id, path, bytes: step.response.length },
      ...(scaffoldFiles.length > 0 ? { scaffold: scaffoldFiles } : {}),
      // Writing a file is not completing an exercise; `aifirst run` records.
      recorded: false,
    });
    return;
  }

  out();
  out(`  ${green(glyph.done)} ${wrote ? "wrote" : "using"} ${bold(path)}  ${dim(step.id)}`);
  if (scaffoldFiles.length > 0) out(dim(`  also prepared ${scaffoldFiles.join(", ")}`));
  out(dim(`  ${glyph.arrow} aifirst run ${example.id}   run it and record it`));
  out();
}
