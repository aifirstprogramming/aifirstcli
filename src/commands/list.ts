/**
 * `aifirst list [book] [--chapter N]`.
 *
 * Browsing surface. Chapters with no authored examples are shown but marked, so a
 * learner can see what's coming without mistaking an unwritten chapter for one
 * they've failed to start.
 */

import type { Args } from "../cli";
import { formatFlag, numberFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import type { Book, Content } from "../content/types";
import { chapters } from "../exercises";
import { read } from "../log/progress";
import type { ProgressLog } from "../log/progress";
import { CliError, bold, cyan, dim, glyph, green, json, out, yellow } from "../output";

/** Resolve a book selector: tag, id, or a distinctive part of the title. */
export function selectBook(content: Content, selector: string): Book {
  const s = selector.toLowerCase();
  const tags: Record<string, string> = { py: "python", python: "python", java: "java" };
  if (tags[s]) {
    const byLanguage = content.books.find((b) => b.language === tags[s]);
    if (byLanguage) return byLanguage;
  }
  const exact = content.books.find((b) => b.id.toLowerCase() === s);
  if (exact) return exact;
  const partial = content.books.filter(
    (b) => b.id.toLowerCase().includes(s) || b.title.toLowerCase().includes(s),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new CliError(
      `"${selector}" matches ${partial.length} books`,
      "ambiguous_book",
      `Try one of: ${content.books.map((b) => b.language).join(", ")}`,
    );
  }
  throw new CliError(
    `No book matches "${selector}"`,
    "unknown_book",
    `Available: ${content.books.map((b) => b.language).join(", ")}`,
  );
}

function statusGlyph(id: string, log: ProgressLog): string {
  const e = log.exercises[id];
  if (e?.status === "done") return green(glyph.done);
  if (e?.status === "skipped") return yellow(glyph.skipped);
  return dim(glyph.todo);
}

export function list(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const { content } = resolveContent();
  const log = read();

  const selector = args.positionals[0] ?? stringFlag(args, "book");
  const chapterFilter = numberFlag(args, "chapter");
  const book = selector ? selectBook(content, selector) : undefined;

  let views = chapters(content);
  if (book) views = views.filter((c) => c.bookId === book.id);
  if (chapterFilter !== undefined) views = views.filter((c) => c.number === chapterFilter);

  if (views.length === 0) {
    throw new CliError(
      chapterFilter !== undefined ? `No chapter ${chapterFilter} found` : "Nothing to list",
      "not_found",
    );
  }

  if (format === "json") {
    json({
      books: content.books
        .filter((b) => !book || b.id === book.id)
        .map((b) => ({
          id: b.id,
          title: b.title,
          language: b.language,
          chapters: views
            .filter((c) => c.bookId === b.id)
            .map((c) => ({
              number: c.number,
              title: c.title,
              goal: c.goal,
              exercises: c.examples.map((e) => ({
                id: e.id,
                title: e.title,
                steps: e.steps.length,
                status: log.exercises[e.id]?.status ?? null,
              })),
            })),
        })),
    });
    return;
  }

  // Grouped by book so a reader of one book isn't wading through the other's
  // chapters to find theirs.
  let currentBook = "";
  out();
  for (const view of views) {
    if (view.bookId !== currentBook) {
      currentBook = view.bookId;
      out(`  ${bold(view.bookTitle)}`);
      out();
    }

    if (view.examples.length === 0) {
      out(`  ${dim(`${view.title} — no examples yet`)}`);
      continue;
    }

    out(`  ${cyan(view.title)}`);
    for (const ex of view.examples) {
      const steps = ex.steps.length > 1 ? dim(` (${ex.steps.length} steps)`) : "";
      out(`    ${statusGlyph(ex.id, log)} ${dim(ex.id.padEnd(11))} ${ex.title}${steps}`);
    }
    out();
  }

  const counted = views.flatMap((v) => v.examples).length;
  out(dim(`  ${counted} exercise(s)   ${glyph.arrow} aifirst show <id>`));
  out();
}
