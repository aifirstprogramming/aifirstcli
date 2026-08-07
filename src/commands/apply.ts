/**
 * `aifirst apply <id> [--into <file>]`.
 *
 * Writes the book's canonical response to a file, byte for byte, and records the
 * exercise as done. This is the deterministic path: no model is involved, so the
 * learner's file matches the printed page exactly.
 *
 * Never overwrites an existing file without `--force`. A learner's own attempt at
 * an exercise is the most valuable thing in the directory.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { resolve } from "@aifirst/content";
import type { Args } from "../cli";
import { boolFlag, formatFlag, numberFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import { finalResponse } from "../exercises";
import { markIfNew } from "../log/progress";
import type { Example, Step } from "../content/types";
import { CliError, bold, dim, glyph, green, json, out } from "../output";

/** snake_case for Python filenames. */
function snake(title: string): string {
  return title
    .replace(/[^A-Za-z0-9 ]+/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .join("_");
}

function pascal(title: string): string {
  return title
    .replace(/[^A-Za-z0-9 ]+/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/**
 * Pick a filename that will actually compile and run.
 *
 * For Java the file must be named after the public class or `javac` rejects it,
 * so the class name is read out of the response rather than guessed from the
 * exercise title.
 */
export function defaultFilename(example: Example, step: Step): string {
  if (example.language === "java") {
    const m = step.response.match(/(?:public\s+)?(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    return `${m ? m[1] : pascal(example.title) || "Main"}.java`;
  }
  return `${snake(example.title) || "main"}.py`;
}

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

  const path = resolvePath(target ?? defaultFilename(example, step));
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

  const recorded = markIfNew(example.id, { via: "apply" });

  if (format === "json") {
    json({
      applied: { exerciseId: example.id, stepId: step.id, path, bytes: step.response.length },
      recorded: recorded !== null,
    });
    return;
  }

  out();
  out(`  ${green(glyph.done)} wrote ${bold(path)}  ${dim(step.id)}`);
  if (recorded) out(dim(`  recorded ${example.id} as done`));
  else out(dim(`  ${example.id} was already recorded`));

  const runHint = example.language === "java" ? `java ${path}` : `python3 ${path}`;
  out(dim(`  ${glyph.arrow} ${runHint}`));
  out();
}
