/**
 * `aifirst book [py|java|all]`.
 *
 * Shows or changes which book the learner is working through. Deliberately
 * changeable at any time: the series is growing, and finishing one book and
 * moving to the next is the expected path, not an edge case.
 */

import type { Args } from "../cli";
import { formatFlag } from "../cli";
import { bookChoices, resolveScope, selectBook } from "../books";
import { ALL_BOOKS, setBook } from "../config";
import { resolveContent } from "../content";
import { report } from "../exercises";
import { read } from "../log/progress";
import { bold, cyan, dim, glyph, green, json, out } from "../output";

export function book(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const { content } = resolveContent();
  const selector = args.positionals[0];

  if (selector) {
    const picked = selectBook(content, selector);
    const value = picked === "all" ? ALL_BOOKS : picked.id;
    setBook(value);

    if (format === "json") {
      json({ book: picked === "all" ? ALL_BOOKS : { id: picked.id, tag: picked.tag, title: picked.title } });
      return;
    }
    out();
    out(
      picked === "all"
        ? `  ${green(glyph.done)} showing exercises from all books`
        : `  ${green(glyph.done)} now reading ${bold(picked.title)}`,
    );
    out(dim(`  ${glyph.arrow} aifirst next`));
    out();
    return;
  }

  const scope = resolveScope(content);
  const log = read();
  const choices = bookChoices(content);

  if (format === "json") {
    json({
      active: scope.kind === "book" ? scope.book.id : scope.kind === "all" ? ALL_BOOKS : null,
      needsBookChoice: scope.kind === "unset",
      books: choices,
    });
    return;
  }

  out();
  if (scope.kind === "unset") {
    out(`  ${bold("No book chosen yet.")}`);
  } else if (scope.kind === "all") {
    out(`  Showing exercises from ${bold("all books")}.`);
  } else {
    out(`  Reading ${bold(scope.book.title)}.`);
  }
  out();

  for (const choice of choices) {
    const counts = report(content, log, {
      kind: "book",
      book: content.books.find((b) => b.id === choice.id)!,
    }).overall;
    const active = scope.kind === "book" && scope.book.id === choice.id;
    const marker = active ? green(glyph.done) : dim(glyph.todo);
    out(`  ${marker} ${bold(choice.tag.padEnd(5))} ${choice.title}  ${dim(`${counts.done}/${counts.total}`)}`);
  }

  out();
  out(dim(`  ${glyph.arrow} aifirst book ${choices[0]?.tag ?? "py"}    switch books`));
  out(dim(`  ${cyan(glyph.arrow)} aifirst book all   show every book`));
  out();
}
