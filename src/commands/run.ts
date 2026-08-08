/**
 * `aifirst run <id>` — write the book's code, run it, and record it.
 *
 * This is what "done" means. Writing a file proves nothing; a learner has
 * finished an exercise when the program actually runs. So completion is recorded
 * here, on exit 0, and nowhere else automatic.
 *
 * stdin, in order of preference:
 *   1. the exercise's authored sample, when it reads input
 *   2. the learner's own keyboard, when attached to a real terminal
 *   3. nothing — and for an input-reading exercise that is an error, not a hang
 *
 * An assistant cannot type into a running program (Claude Code's `!` prefix does
 * not attach an interactive stdin), which is exactly why case 1 exists.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { resolve, runCommand, suggestFilename } from "@aifirst/content";
import { which } from "../agents/util";
import type { Args } from "../cli";
import { boolFlag, formatFlag, numberFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import type { Example, Step } from "../content/types";
import { finalResponse } from "../exercises";
import { markIfNew } from "../log/progress";
import { CliError, bold, cyan, dim, glyph, green, json, out, red } from "../output";

const TIMEOUT_MS = 30_000;

/** Pick the step to run, honouring --step and a step-level id. */
function pickStep(args: Args, example: Example, addressed?: Step): Step {
  const stepNumber = numberFlag(args, "step");
  if (stepNumber !== undefined) {
    const found = example.steps.find((s) => s.index === stepNumber);
    if (!found) {
      throw new CliError(
        `${example.id} has ${example.steps.length} step(s); there is no step ${stepNumber}`,
        "unknown_step",
      );
    }
    return found;
  }
  // A whole multi-step example runs its final step: the steps are progressive,
  // so earlier ones are half-built versions of the same program.
  return addressed ?? finalResponse(example);
}

export async function run(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const id = args.positionals[0];
  if (!id) {
    throw new CliError("run needs an exercise id", "missing_argument", "Try: aifirst run py-1-01");
  }

  const { content } = resolveContent();
  const hit = resolve(id, content);
  const example = hit.example;
  const step = pickStep(args, example, hit.kind === "step" ? hit.step : undefined);

  const body = step.response.endsWith("\n") ? step.response : step.response + "\n";
  const path = resolvePath(stringFlag(args, "into") ?? suggestFilename(example, step));
  const force = boolFlag(args, "force");

  // Write it, but never over something different that the learner wrote.
  let wrote = false;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing !== body && !force) {
      throw new CliError(
        `${path} already exists with different contents`,
        "file_exists",
        `That may be your own attempt. Pass --force to replace it, or --into <file> to use another name.`,
      );
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    wrote = true;
  }

  const command = runCommand(example.language, path);
  if (!command) {
    throw new CliError(
      `Don't know how to run ${example.language} exercises`,
      "unsupported_language",
      `The file is written at ${path}; run it yourself, then: aifirst done ${example.id}`,
    );
  }
  if (!which(command[0])) {
    throw new CliError(
      `${command[0]} is not installed`,
      "missing_runtime",
      example.language === "java"
        ? `Install a JDK (11 or newer) to run Java exercises. The file is written at ${path}.`
        : `Install Python 3 to run Python exercises. The file is written at ${path}.`,
    );
  }

  // Decide how the program gets its input.
  const interactive = step.interactive;
  const hasTty = Boolean(process.stdin.isTTY);
  if (interactive && step.stdin === undefined && !hasTty) {
    throw new CliError(
      `${step.id} reads input and has no sample, and there is no terminal attached`,
      "needs_interactive_run",
      `Ask the learner to run it themselves: aifirst run ${step.id}`,
    );
  }
  const useTty = interactive && step.stdin === undefined && hasTty;

  const proc = Bun.spawn(command, {
    cwd: dirname(path),
    stdin: useTty ? "inherit" : step.stdin === undefined ? "ignore" : new TextEncoder().encode(step.stdin),
    stdout: useTty ? "inherit" : "pipe",
    stderr: useTty ? "inherit" : "pipe",
  });

  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [stdout, stderr] = useTty
    ? ["", ""]
    : await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);

  const timedOut = proc.exitCode === null;
  const ok = proc.exitCode === 0;
  const output = `${stdout}${stderr}`.replace(/\n$/, "");

  // The whole point: only a clean run records progress.
  const recorded = ok ? markIfNew(example.id, { via: "run" }) : null;

  if (format === "json") {
    json({
      exerciseId: example.id,
      stepId: step.id,
      path,
      wrote,
      ran: { ok, exitCode: proc.exitCode, timedOut, stdout, stderr },
      ...(step.stdin === undefined ? {} : { stdin: step.stdin }),
      recorded: recorded !== null,
    });
    if (!ok) process.exitCode = 1;
    return;
  }

  out();
  out(`  ${wrote ? green(glyph.done) : dim(glyph.done)} ${wrote ? "wrote" : "using"} ${bold(path)}  ${dim(step.id)}`);
  if (step.stdin !== undefined) {
    out(dim(`  input: ${JSON.stringify(step.stdin)}`));
  }

  if (!useTty) {
    out();
    for (const line of output.split("\n")) out(`  ${line}`);
  }
  out();

  if (ok) {
    out(
      recorded
        ? `  ${green(glyph.done)} ran clean — recorded ${bold(example.id)} as done`
        : `  ${green(glyph.done)} ran clean — ${dim(`${example.id} was already recorded`)}`,
    );
    out();
    return;
  }

  out(
    `  ${red(glyph.todo)} ${
      timedOut ? `still running after ${TIMEOUT_MS / 1000}s` : `exited ${proc.exitCode}`
    } — not recorded`,
  );
  out(dim(`  ${cyan(glyph.arrow)} fix it and run again, or: aifirst done ${example.id}`));
  out();
  process.exitCode = 1;
}
