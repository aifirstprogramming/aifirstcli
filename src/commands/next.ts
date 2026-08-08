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
 */

import type { Args } from "../cli";
import { boolFlag, formatFlag, stringFlag } from "../cli";
import { bookChoices, resolveScope } from "../books";
import { resolveContent } from "../content";
import { exampleJson, next as nextExercise, report } from "../exercises";
import { read } from "../log/progress";
import { bold, cyan, dim, glyph, green, json, out } from "../output";

export function next(args: Args): void {
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

  const ex = nextExercise(content, log, scope);
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

  if (format === "json") {
    json({ next: exampleJson(ex, log), complete: false, counts });
    return;
  }

  const first = ex.steps[0];
  out();
  out(`  ${bold(ex.title)}  ${dim(ex.id)}`);
  out(`  ${dim(`${ex.bookTitle} ${glyph.bullet} ${ex.chapterTitle}`)}`);
  if (ex.description) {
    out();
    out(`  ${ex.description}`);
  }
  out();
  out(`  ${cyan(ex.steps.length > 1 ? `Prompt 1/${ex.steps.length}` : "Prompt")}`);
  out(`  ${bold(first.prompt)}`);
  out();
  out(dim(`  ${glyph.arrow} paste that prompt into your AI assistant, then:`));
  out(dim(`     aifirst show ${ex.id}    compare against the book`));
  out(dim(`     aifirst run ${ex.id}     write it, run it, and record it`));
  out();
  out(dim(`  ${counts.done}/${counts.total} exercises done in ${ex.bookTitle}`));
  out();
}
