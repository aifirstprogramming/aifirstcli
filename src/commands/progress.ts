/**
 * `aifirst progress [--format text|json|md]`.
 *
 * The learner's own ledger. Percentages are over **authored** exercises only —
 * both books have chapters written ahead of their examples, and counting those
 * would tell a student they're 15% done when they've finished everything that
 * exists.
 *
 * `--format md` exists so a learner can paste a summary into a journal, a
 * standup, or a course forum. It's a convenience, not an attestation.
 */

import type { Args } from "../cli";
import { boolFlag, formatFlag, stringFlag } from "../cli";
import { resolveScope } from "../books";
import { resolveContent } from "../content";
import { report } from "../exercises";
import { read } from "../log/progress";
import { bar, bold, dim, glyph, green, json, out, table, yellow } from "../output";

export function progress(args: Args): void {
  const format = formatFlag(args);
  const { content, version, source } = resolveContent();
  const log = read();
  // Scoped to the reader's book so the denominator is one they can finish.
  const scope = resolveScope(content, {
    selector: args.positionals[0] ?? stringFlag(args, "book"),
    all: boolFlag(args, "all"),
  });
  const r = report(content, log, scope);

  if (format === "json") {
    json({ ...r, content: { pack: version, source } });
    return;
  }

  if (format === "md") {
    out(`# AI First progress`);
    out();
    out(`${r.overall.done} of ${r.overall.total} exercises complete (${pct(r.overall.fraction)}).`);
    out();
    for (const book of r.books) {
      out(`## ${book.bookTitle}`);
      out();
      out(`${book.counts.done}/${book.counts.total} complete (${pct(book.counts.fraction)})`);
      out();
      const withContent = book.chapters.filter((c) => !c.empty);
      if (withContent.length > 0) {
        out(`| Chapter | Done | Total |`);
        out(`| --- | --: | --: |`);
        for (const c of withContent) {
          out(`| ${c.title} | ${c.counts.done} | ${c.counts.total} |`);
        }
        out();
      }
      const pending = book.chapters.filter((c) => c.empty).length;
      if (pending > 0) out(`_${pending} chapter(s) have no exercises published yet._`);
      out();
    }
    return;
  }

  out();
  out(`  ${bold("AI First progress")}   ${dim(`content pack ${version}`)}`);
  out();
  out(`  ${bar(r.overall.fraction)}  ${bold(pct(r.overall.fraction))}   ${dim(
    `${r.overall.done} done, ${r.overall.skipped} skipped, ${r.overall.remaining} to go`,
  )}`);
  out();

  for (const book of r.books) {
    out(`  ${bold(book.bookTitle)}`);
    out(`  ${bar(book.counts.fraction, 16)} ${dim(`${book.counts.done}/${book.counts.total}`)}`);

    const rows: [string, string][] = book.chapters
      .filter((c) => !c.empty)
      .map((c) => {
        const marker =
          c.counts.total > 0 && c.counts.done === c.counts.total
            ? green(glyph.done)
            : c.counts.done > 0
              ? yellow(glyph.partial)
              : dim(glyph.todo);
        return [`${marker} ${c.title}`, dim(`${c.counts.done}/${c.counts.total}`)];
      });
    if (rows.length > 0) {
      out();
      out(table(rows, "    "));
    }

    const pending = book.chapters.filter((c) => c.empty).length;
    if (pending > 0) {
      out();
      out(dim(`    ${pending} chapter(s) with no exercises published yet`));
    }
    out();
  }

  out(dim(`  ${glyph.arrow} aifirst next    continue where you left off`));
  out();
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
