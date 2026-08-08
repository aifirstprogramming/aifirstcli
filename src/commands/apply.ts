/**
 * `aifirst apply <id> [--into <file>]`.
 *
 * Writes the book's canonical response to a file, byte for byte. No model is
 * involved, so the learner's file matches the printed page exactly.
 *
 * Deliberately does **not** record progress — see `aifirst run`, which writes and
 * then executes, and records only when the program actually runs. Marking an
 * exercise done for writing a file was the original behaviour and it let an
 * assistant tick off an exercise it had neither written nor run.
 *
 * Never overwrites an existing file without `--force`. A learner's own attempt at
 * an exercise is the most valuable thing in the directory.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { resolve, suggestFilename } from "@aifirst/content";
import type { Args } from "../cli";
import { boolFlag, formatFlag, numberFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import { finalResponse } from "../exercises";
import type { Step } from "../content/types";
import { CliError, bold, dim, glyph, green, json, out } from "../output";


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

  const path = resolvePath(target ?? suggestFilename(example, step));
  const force = boolFlag(args, "force");

  if (existsSync(path) && !force) {
    throw new CliError(
      `${path} already exists`,
      "file_exists",
      `Pass --force to overwrite, --into <file> to choose another name, or --into - to print it`,
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, step.response.endsWith("\n") ? step.response : step.response + "\n");

  if (format === "json") {
    json({
      applied: { exerciseId: example.id, stepId: step.id, path, bytes: step.response.length },
      // Writing a file is not completing an exercise; `aifirst run` records.
      recorded: false,
    });
    return;
  }

  out();
  out(`  ${green(glyph.done)} wrote ${bold(path)}  ${dim(step.id)}`);
  out(dim(`  ${glyph.arrow} aifirst run ${example.id}   run it and record it`));
  out();
}
