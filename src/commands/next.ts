/**
 * `aifirst next`.
 *
 * The "where was I" command, and the one the book points readers at. Shows the
 * first authored exercise with no log entry, skipping chapters that have no
 * examples written yet.
 */

import type { Args } from "../cli";
import { formatFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import { exampleJson, next as nextExercise, report } from "../exercises";
import { read } from "../log/progress";
import { bold, cyan, dim, glyph, green, json, out } from "../output";
import { selectBook } from "./list";

export function next(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const { content } = resolveContent();
  const log = read();

  const selector = args.positionals[0] ?? stringFlag(args, "book");
  const book = selector ? selectBook(content, selector) : undefined;

  const ex = nextExercise(content, log, book?.id);
  const counts = report(content, log).overall;

  if (!ex) {
    if (format === "json") {
      json({ next: null, complete: true, counts });
      return;
    }
    out();
    out(`  ${green(glyph.done)} ${bold("Everything authored so far is complete.")}`);
    out(dim(`  ${counts.done} done, ${counts.skipped} skipped, of ${counts.total} exercises`));
    out(dim(`  ${glyph.arrow} aifirst update --content    check for new book content`));
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
  out(dim(`     aifirst show ${ex.id}     compare against the book`));
  out(dim(`     aifirst apply ${ex.id}    write the book's answer to a file`));
  out(dim(`     aifirst done ${ex.id}     mark it complete`));
  out();
  out(dim(`  ${counts.done}/${counts.total} exercises done`));
  out();
}
