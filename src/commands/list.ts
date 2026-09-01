/**
 * `aifirst list [book] [--chapter N]`.
 *
 * Browsing surface. Chapters with no authored examples are shown but marked, so a
 * learner can see what's coming without mistaking an unwritten chapter for one
 * they've failed to start.
 */

import type { Args } from "../cli";
import { boolFlag, formatFlag, numberFlag, stringFlag } from "../cli";
import { inScope, resolveScope } from "../books";
import { resolveContent } from "../content";
import { chapters } from "../exercises";
import { read } from "../log/progress";
import type { ProgressLog } from "../log/progress";
import { CliError, bold, cyan, dim, glyph, green, json, out, yellow } from "../output";

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

  const chapterFilter = numberFlag(args, "chapter");
  // Browsing works before a book is chosen — it just isn't narrowed. Only `next`
  // needs a decision, because only `next` has to pick one exercise.
  const scope = resolveScope(content, {
    selector: args.positionals[0] ?? stringFlag(args, "book"),
    all: boolFlag(args, "all"),
  });

  let views = chapters(content).filter((c) => inScope(scope, c.bookId));
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
        .filter((b) => inScope(scope, b.id))
        .map((b) => ({
          id: b.id,
          tag: b.tag,
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
                dependencies: e.dependencies ?? [],
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
      const dependencies = ex.dependencies?.length
        ? dim(` (requires ${ex.dependencies.map((dependency) => dependency.package).join(", ")})`)
        : "";
      out(`    ${statusGlyph(ex.id, log)} ${dim(ex.id.padEnd(11))} ${ex.title}${steps}${dependencies}`);
    }
    out();
  }

  const counted = views.flatMap((v) => v.examples).length;
  out(dim(`  ${counted} exercise(s)   ${glyph.arrow} aifirst show <id>`));
  out();
}
