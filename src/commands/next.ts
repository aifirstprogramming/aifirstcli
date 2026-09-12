/**
 * `aifirst next`.
 *
 * The "where was I" command, and the one the book points readers at.
 *
 * Two rules it must not break:
 *  - It never crosses out of the reader's book. Readers own one book of a
 *    growing series; being handed another book's exercises is confusing at best.
 *  - It never guesses which book that is. Before a choice is made it says so and
 *    lists the options, so the learner (or their assistant) is asked.
 *
 * In bare-mode learning, `next` is the full cycle: it presents the exercise,
 * writes the canonical code, runs it, explains it, records success, and
 * advances to the next exercise, all in one call. `show` stays read-only;
 * `run` stays explicit write/run/record.
 */

import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Args } from "../cli";
import { boolFlag, formatFlag, numberFlag, stringFlag } from "../cli";
import { bookChoices, resolveScope } from "../books";
import { resolveContent } from "../content";
import { finalResponse, report, resume } from "../exercises";
import { which } from "../agents/util";
import { read, markIfNew } from "../log/progress";
import { CliError, bold, cyan, dim, explanationBlock, glyph, green, json, out, red } from "../output";
import { preflightDependencies } from "./dependencies";
import { defaultExercisePath } from "../workspace";
import { commandsFor, executionMode, executionSuccessText, junitJar, prepareExerciseFiles, runTimeoutMs } from "./run";

export async function next(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const { content } = resolveContent();
  const log = read();

  const scope = resolveScope(content, {
    selector: args.positionals[0] ?? stringFlag(args, "book"),
    all: boolFlag(args, "all"),
  });

  // Unset is a real state, not a default to paper over.
  if (scope.kind === "unset") {
    const choices = bookChoices(content);
    if (format === "json") {
      json({ needsBookChoice: true, books: choices, next: null });
      process.exitCode = 1;
      return;
    }
    out();
    out(`  ${bold("Which book are you reading?")}`);
    out();
    for (const c of choices) {
      out(`    ${bold(c.tag.padEnd(5))} ${c.title} ${dim(`(${c.exercises} exercises)`)}`);
    }
    out();
    out(dim(`  ${glyph.arrow} aifirst book ${choices[0]?.tag ?? "py"}`));
    out();
    process.exitCode = 1;
    return;
  }

  const picked = resume(content, log, scope, { earliest: boolFlag(args, "earliest") });
  const ex = picked.example;
  const counts = report(content, log, scope).overall;

  if (!ex) {
    const finished = scope.kind === "book" ? scope.book : undefined;
    const others = content.books.filter((b) => b.id !== finished?.id);

    if (format === "json") {
      json({
        next: null,
        complete: true,
        book: finished ? { id: finished.id, tag: finished.tag, title: finished.title } : null,
        counts,
        otherBooks: others.map((b) => ({ id: b.id, tag: b.tag, title: b.title })),
      });
      return;
    }

    out();
    if (finished) {
      out(`  ${green("🎉")} ${bold(`You've finished every exercise in ${finished.title}!`)}`);
    } else {
      out(`  ${green("🎉")} ${bold("You've finished every exercise available.")}`);
    }
    out(dim(`  ${counts.done} completed, ${counts.skipped} skipped, of ${counts.total}`));
    out();
    if (others.length > 0) {
      out(`  Ready for another book?`);
      for (const b of others) out(dim(`    aifirst book ${b.tag.padEnd(5)}  ${b.title}`));
      out();
    }
    out(dim(`  ${glyph.arrow} aifirst update --content    check for newly published exercises`));
    out();
    return;
  }

  // ── BARE-MODE CYCLE: write → run → record → advance ──

  const step = finalResponse(ex);
  const into = stringFlag(args, "into");
  const retryCommand = [
    "aifirst next",
    ...(args.positionals[0] ? [JSON.stringify(args.positionals[0])] : []),
    "--yes",
    ...(into ? ["--into", JSON.stringify(into)] : []),
    ...(boolFlag(args, "force") ? ["--force"] : []),
    ...(boolFlag(args, "earliest") ? ["--earliest"] : []),
    ...(format === "json" ? ["--format json"] : []),
  ].join(" ");
  const dependencyReport = await preflightDependencies(args, ex, step, format, retryCommand);
  let prepared;
  try {
    prepared = prepareExerciseFiles(content, ex, step, {
      into: into ?? defaultExercisePath(content, ex, step),
      force: boolFlag(args, "force"),
    });
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "file_exists") throw error;
    if (format === "json") {
      json({
        completed: false,
        exerciseId: ex.id,
        wrote: false,
        ran: null,
        recorded: false,
        next: { id: ex.id, title: ex.title, language: ex.language },
      });
    } else {
      out(`  ${red(glyph.todo)} ${bold(error.message)}`);
      out(dim(`  Pass --force to replace, or write this exercise elsewhere with --into <file>.`));
      out();
    }
    process.exitCode = 1;
    return;
  }
  const { path, cwd, wrote } = prepared;

  // Run the exercise.
  const hasTty = Boolean(process.stdin.isTTY);
  const interactive = step.interactive;
  const useTty = interactive && step.stdin === undefined && hasTty;

  // Use the same command planner as `run`; a class may only compile, while a
  // scaffolded program can require a separate compile and launch command.
  const fileName = basename(path);
  const commands = commandsFor(ex, step, fileName, dependencyReport.runtime);
  const mode = executionMode(ex, step);
  const runCmd = commands[0]!;

  const usesJunitLauncher = commands.some((command) => command.includes(junitJar()));
  if (usesJunitLauncher && !existsSync(junitJar())) {
    throw new CliError(
      `${ex.id} is a JUnit test and the JUnit launcher is not installed`,
      "missing_junit",
      `Install it with \`aifirst doctor\`, then run this exercise again.`,
    );
  }

  if (!which(runCmd[0])) {
    const message = `${runCmd[0]} is not installed`;
    const hint =
      ex.language === "java"
        ? `Install a JDK (11 or newer) to run Java exercises. The file is written at ${path}.`
        : `Install Python 3 to run Python exercises. The file is written at ${path}.`;
    throw new CliError(message, "missing_runtime", hint);
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let timedOut = false;
  let timedOutAfterMs: number | undefined;
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!;
    const last = index === commands.length - 1;
    const proc = Bun.spawn(command, {
      cwd,
      stdin: useTty && last ? "inherit" : step.stdin === undefined || !last ? "ignore" : new TextEncoder().encode(step.stdin),
      stdout: useTty && last ? "inherit" : "pipe",
      stderr: useTty && last ? "inherit" : "pipe",
    });
    const timeoutMs = runTimeoutMs(args, step.execution, index, commands.length);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => proc.kill(), timeoutMs);
    const [commandStdout, commandStderr] = useTty && last
      ? ["", ""]
      : await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    if (timer) clearTimeout(timer);
    stdout += commandStdout;
    stderr += commandStderr;
    exitCode = proc.exitCode ?? 1;
    timedOut = proc.exitCode === null;
    if (timedOut) timedOutAfterMs = timeoutMs;
    if (exitCode !== 0) break;
  }
  const output = `${stdout}${stderr}`.replace(/\n$/, "");

  // Some exercises teach error handling by throwing on purpose.
  const deliberate = step.expectsException === true && exitCode !== 0 && !timedOut && stdout.trim() !== "";
  const ok = exitCode === 0 || deliberate;

  // Record only on success.
  const recorded = ok ? markIfNew(ex.id, { via: "agent" }) : null;

  // Compute the next exercise (after this one has been recorded, if successful).
  const newLog = read();
  const nextEx = resume(content, newLog, scope, { earliest: boolFlag(args, "earliest") }).example;

  // ── OUTPUT ──

  if (format === "json") {
    const nextJson = nextEx
      ? { id: nextEx.id, title: nextEx.title, language: nextEx.language }
      : null;
    json({
      completed: ok,
      exerciseId: ex.id,
      stepId: step.id,
      path,
      wrote,
      ran: ok
        ? { ok: true, exitCode: 0, timedOut: false, stdout, stderr, commands: commands.map((command) => command.join(" ")) }
        : { ok: false, exitCode, timedOut, stdout, stderr, commands: commands.map((command) => command.join(" ")) },
      execution: {
        mode,
        ok,
        commands: commands.map((command) => command.join(" ")),
        ...(step.execution.launch ? { launch: step.execution.launch } : {}),
      },
      recorded: recorded !== null,
      dependencies: dependencyReport.dependencies,
      next: nextJson,
      counts,
      ...(picked.from ? { resumedFrom: picked.from } : {}),
      ...(picked.earlierUnfinished > 0 ? { earlierUnfinished: picked.earlierUnfinished } : {}),
    });
    if (!ok) process.exitCode = 1;
    return;
  }

  // Text output: show the exercise, the code, the run result, and what's next.
  out();
  out(`  ${bold(ex.title)}  ${dim(ex.id)}`);
  out(`  ${dim(`${ex.bookTitle} ${glyph.bullet} ${ex.chapterTitle}`)}`);
  if (ex.description) {
    out();
    out(`  ${ex.description}`);
  }
  out();
  out(`  ${cyan("Code")} ${dim(`(${ex.language})`)}`);
  out(`\`\`\`${ex.language}`);
  out(step.response);
  out("```");

  if (ok && step.explanation) {
    out();
    for (const line of explanationBlock(step.explanation)) out(line);
  }

  if (!useTty) {
    out();
    out(`  ${cyan("Output")}`);
    out();
    for (const line of output.split("\n")) out(`  ${line}`);
  }
  out();

  if (ok) {
    out(
      recorded
        ? `  ${green(glyph.done)} ${executionSuccessText(mode)}, recorded ${bold(ex.id)} as done`
        : `  ${green(glyph.done)} ${executionSuccessText(mode)}, ${dim(`${ex.id} was already recorded`)}`,
    );
  } else {
    out(
      `  ${red(glyph.todo)} ${timedOut ? `still running after ${(timedOutAfterMs ?? 30_000) / 1000}s` : `exited ${exitCode}`}` +
        `, not recorded`,
    );
  }

  // Show what's next.
  if (nextEx) {
    out();
    out(`  ${cyan("Next")}  ${dim(nextEx.id)}: ${nextEx.title}`);
  } else {
    const finished = scope.kind === "book" ? scope.book : undefined;
    out();
    if (finished) {
      out(`  ${green("🎉")} ${bold(`You've finished every exercise in ${finished.title}!`)}`);
    } else {
      out(`  ${green("🎉")} ${bold("You've finished every exercise available.")}`);
    }
  }
  out();
}
