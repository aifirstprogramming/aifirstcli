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
 * advances to the next exercise — all in one call. `show` stays read-only;
 * `run` stays explicit write/run/record.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { exercisePath } from "@aifirst/content";
import type { Args } from "../cli";
import { boolFlag, formatFlag, numberFlag, stringFlag } from "../cli";
import { bookChoices, resolveScope } from "../books";
import { resolveContent } from "../content";
import { finalResponse, report, resume } from "../exercises";
import { read, markIfNew } from "../log/progress";
import { CliError, bold, codeBlock, cyan, dim, explanationBlock, glyph, green, json, out, red } from "../output";

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
  const body = step.response.endsWith("\n") ? step.response : step.response + "\n";
  const path = resolvePath(stringFlag(args, "into") ?? exercisePath(ex, step));
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

  // Run the exercise.
  const TIMEOUT_MS = 30_000;
  const hasTty = Boolean(process.stdin.isTTY);
  const interactive = step.interactive;
  const useTty = interactive && step.stdin === undefined && hasTty;

  // Figure out the run command.
  let runCmd: string[];
  if (ex.language === "python") {
    const entry = step.scaffold?.entrypoint;
    const fileName = path.split("/").pop() ?? path;
    runCmd = entry ? ["python3", entry] : ["python3", fileName];
  } else if (ex.language === "java") {
    const entry = step.scaffold?.entrypoint;
    const runFile = entry ?? path.split("/").pop() ?? path;
    const extraSources = (step.scaffold?.files ?? []).some((f) => f.path.endsWith(".java"));
    if (extraSources) {
      runCmd = ["java", "-cp", "out", runFile.replace(/\.java$/, "")];
    } else {
      runCmd = ["java", runFile];
    }
  } else {
    runCmd = ["python3", path.split("/").pop() ?? path];
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
  out(codeBlock(step.response));

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
        ? `  ${green(glyph.done)} ran clean — recorded ${bold(ex.id)} as done`
        : `  ${green(glyph.done)} ran clean — ${dim(`${ex.id} was already recorded`)}`,
    );
    if (step.explanation) {
      out();
      for (const line of explanationBlock(step.explanation)) out(line);
    }
  } else {
    out(
      `  ${red(glyph.todo)} ${timedOut ? `still running after ${TIMEOUT_MS / 1000}s` : `exited ${exitCode}`}` +
        ` — not recorded`,
    );
  }

  // Show what's next.
  if (nextEx) {
    out();
    out(`  ${cyan("Next")}  ${dim(nextEx.id)} — ${nextEx.title}`);
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
