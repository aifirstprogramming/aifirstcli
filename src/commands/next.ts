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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { runCommand } from "@aifirst/content";
import type { Args } from "../cli";
import { boolFlag, formatFlag, numberFlag, stringFlag } from "../cli";
import { bookChoices, resolveScope } from "../books";
import { resolveContent } from "../content";
import { writeScaffold } from "../content/scaffold";
import { finalResponse, report, resume } from "../exercises";
import { which } from "../agents/util";
import { read, markIfNew } from "../log/progress";
import { CliError, bold, cyan, dim, explanationBlock, glyph, green, json, out, red } from "../output";
import { withPythonRuntime } from "../dependencies";
import { preflightDependencies } from "./dependencies";
import { defaultExercisePath } from "../workspace";

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
  const body = step.response.endsWith("\n") ? step.response : step.response + "\n";
  const path = resolvePath(into ?? defaultExercisePath(content, ex, step));
  const force = boolFlag(args, "force");

  // Write it, but never over something different that the learner wrote.
  let wrote = false;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    const same = existing.replace(/\r\n/g, "\n").replace(/\n+$/, "") === body.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    if (same) {
      // Already this exercise's code; nothing to write.
    } else if (force) {
      writeFileSync(path, body);
      wrote = true;
    } else {
      if (format === "json") {
        json({
          completed: false,
          exerciseId: ex.id,
          wrote: false,
          ran: null,
          recorded: false,
          next: { id: ex.id, title: ex.title, language: ex.language },
        });
        process.exitCode = 1;
        return;
      }
      out(`  ${red(glyph.todo)} ${bold(path)} already exists with different contents`);
      out(dim(`  Pass --force to replace, or write this exercise elsewhere with --into <file>.`));
      out();
      process.exitCode = 1;
      return;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    wrote = true;
  }

  // Project exercises may run a scaffold entrypoint rather than the default
  // response filename. Match `run` by materializing those owned support files
  // before resolving and launching the command.
  writeScaffold(dirname(path), step, content);

  // Run the exercise.
  const TIMEOUT_MS = 30_000;
  const hasTty = Boolean(process.stdin.isTTY);
  const interactive = step.interactive;
  const useTty = interactive && step.stdin === undefined && hasTty;

  // Figure out the run command. Use the shared @aifirst/content command builder so
  // next and run never drift on how a language is invoked, and basename() instead
  // of a hard-coded "/" split so this works on Windows paths too.
  const entry = step.scaffold?.entrypoint;
  const fileName = basename(path);
  let runCmd: string[];
  if (ex.language === "java") {
    const runFile = entry ?? fileName;
    const extraSources = (step.scaffold?.files ?? []).some((f) => f.path.endsWith(".java"));
    runCmd = extraSources
      ? ["java", "-cp", "out", runFile.replace(/\.java$/, "")]
      : (runCommand("java", runFile) ?? ["java", runFile]);
  } else if (entry) {
    runCmd = runCommand(ex.language, entry) ?? ["python3", entry];
  } else {
    runCmd = runCommand(ex.language, fileName) ?? ["python3", fileName];
  }
  if (dependencyReport.runtime) runCmd = withPythonRuntime(runCmd, dependencyReport.runtime);

  if (!which(runCmd[0])) {
    const message = `${runCmd[0]} is not installed`;
    const hint =
      ex.language === "java"
        ? `Install a JDK (11 or newer) to run Java exercises. The file is written at ${path}.`
        : `Install Python 3 to run Python exercises. The file is written at ${path}.`;
    throw new CliError(message, "missing_runtime", hint);
  }

  const proc = Bun.spawn(runCmd, {
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

  const exitCode = proc.exitCode ?? 1;
  const timedOut = proc.exitCode === null;
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
        ? { ok: true, exitCode: 0, timedOut: false, stdout, stderr }
        : { ok: false, exitCode, timedOut, stdout, stderr },
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
        ? `  ${green(glyph.done)} ran clean, recorded ${bold(ex.id)} as done`
        : `  ${green(glyph.done)} ran clean, ${dim(`${ex.id} was already recorded`)}`,
    );
  } else {
    out(
      `  ${red(glyph.todo)} ${timedOut ? `still running after ${TIMEOUT_MS / 1000}s` : `exited ${exitCode}`}` +
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
