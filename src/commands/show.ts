/**
 * `aifirst show <id>` and `aifirst prompt <id>`.
 *
 * `show` is the oracle an agent calls to get the book's canonical answer.
 * `prompt` prints only the prompt text, for a learner who wants to paste it into
 * a chat themselves rather than retype it from the page.
 *
 * Neither marks progress — reading an exercise isn't completing it.
 */

import { resolve } from "@aifirst/content";
import type { Args } from "../cli";
import { formatFlag } from "../cli";
import { resolveContent } from "../content";
import { exampleJson, stepJson } from "../exercises";
import { read } from "../log/progress";
import { CliError, bold, codeBlock, cyan, dim, explanationBlock, glyph, json, out } from "../output";

function requireId(args: Args, command: string): string {
  const id = args.positionals[0];
  if (!id) {
    throw new CliError(`${command} needs an exercise id`, "missing_argument", `Try: aifirst ${command} py-1-01`);
  }
  return id;
}

export function show(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const id = requireId(args, "show");
  const { content } = resolveContent();
  const log = read();

  const hit = resolve(id, content);
  const steps = hit.kind === "step" ? [hit.step] : hit.example.steps;

  if (format === "json") {
    json(exampleJson(hit.example, log, steps));
    return;
  }

  const ex = hit.example;
  out();
  out(`  ${bold(ex.title)}  ${dim(ex.id)}`);
  out(`  ${dim(`${ex.bookTitle} ${glyph.bullet} ${ex.chapterTitle}`)}`);
  if (ex.description) {
    out();
    out(`  ${ex.description}`);
  }
  if (ex.dependencies?.length) {
    out();
    out(`  ${cyan("Dependencies")}  ${ex.dependencies.map((dependency) => dependency.package).join(", ")}`);
  }

  for (const step of steps) {
    out();
    const label = step.total > 1 ? `Prompt ${step.index}/${step.total}` : "Prompt";
    out(`  ${cyan(label)}  ${dim(step.id)}`);
    out(`  ${bold(step.prompt)}`);
    out();
    out(`  ${cyan("Response")} ${dim(`(${ex.language})`)}`);
    out(codeBlock(step.response));

    if (step.explanation) {
      out();
      for (const line of explanationBlock(step.explanation)) out(line);
    }
  }

  out();
  const entry = log.exercises[ex.id];
  if (entry) {
    out(dim(`  recorded ${entry.status}${entry.variant ? ` as a ${entry.variant.kind} variant` : ""} ${new Date(entry.at).toLocaleString()}`));
  } else {
    out(dim(`  ${glyph.arrow} aifirst apply ${ex.id}   writes this to a file and records it`));
  }
  out();
}

export function prompt(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const id = requireId(args, "prompt");
  const { content } = resolveContent();

  const hit = resolve(id, content);
  const steps = hit.kind === "step" ? [hit.step] : hit.example.steps;

  if (format === "json") {
    json({ id: hit.example.id, steps: steps.map(stepJson).map(({ id, index, total, prompt }) => ({ id, index, total, prompt })) });
    return;
  }

  // Bare prompt text only, so this is safe to pipe into a clipboard tool.
  for (const step of steps) out(step.prompt);
}
