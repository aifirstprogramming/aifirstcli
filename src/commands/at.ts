/**
 * `aifirst at [<id>]` — show or move where you are in the book.
 *
 * The bookmark advances on its own as exercises are recorded, so most learners
 * never need this. It exists for the case the automatic rule cannot cover: jumping
 * to the chapter you are actually reading, without pretending to have done the
 * exercises in between.
 *
 * Deliberately separate from `skip`. Skipping says "not this one, don't offer it
 * again" and is recorded per exercise; the bookmark says "this is where I am" and
 * says nothing about the exercises behind it. Holding a place in chapter 7 by
 * skipping the forty-odd exercises before it would be a lie in the ledger.
 */

import { resolve } from "@aifirst/content";
import type { Args } from "../cli";
import { boolFlag, formatFlag } from "../cli";
import { resolveContent } from "../content";
import { read, setPosition } from "../log/progress";
import { CliError, bold, cyan, dim, glyph, green, json, out } from "../output";

export function at(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const { content } = resolveContent();

  if (boolFlag(args, "clear")) {
    setPosition(undefined);
    if (format === "json") {
      json({ position: null, cleared: true });
      return;
    }
    out();
    out(`  ${green(glyph.done)} cleared — ${bold("next")} goes back to the earliest unfinished exercise`);
    out();
    return;
  }

  const target = args.positionals[0];

  // No argument: report, rather than guessing what was meant.
  if (!target) {
    const current = read().position;
    if (format === "json") {
      json({ position: current ?? null });
      return;
    }
    out();
    if (!current) {
      out(`  No bookmark yet — ${bold("next")} offers the earliest unfinished exercise.`);
      out();
      out(dim(`  ${glyph.arrow} aifirst at py-7-03    start from there instead`));
    } else {
      const hit = resolve(current, content);
      out(`  You are at ${bold(current)}  ${dim(hit.example.title)}`);
      out(`  ${dim(`${hit.example.bookTitle} ${glyph.bullet} ${hit.example.chapterTitle}`)}`);
      out();
      out(dim(`  ${glyph.arrow} aifirst next          continue from here`));
      out(dim(`     aifirst at --clear   go back to the earliest unfinished exercise`));
    }
    out();
    return;
  }

  // Resolves prefixes and step ids, so `aifirst at py-7-3` works.
  const hit = resolve(target, content);
  const ex = hit.example;
  setPosition(ex.id);

  if (format === "json") {
    json({ position: ex.id, title: ex.title, chapter: ex.chapterTitle, book: ex.bookTitle });
    return;
  }

  out();
  out(`  ${green(glyph.done)} now at ${bold(ex.id)}  ${dim(ex.title)}`);
  out(`  ${dim(`${ex.bookTitle} ${glyph.bullet} ${ex.chapterTitle}`)}`);
  out();
  out(dim(`  ${cyan(glyph.arrow)} aifirst next    continue from here`));
  out();
}

/** Used by the help text and by `next` when it has nothing to offer. */
export function positionHint(): string {
  return "aifirst at <id>   move to a different part of the book";
}

/** Raised when a caller asks for a position that is not an exercise. */
export function unknownPosition(target: string): CliError {
  return new CliError(`${target} is not an exercise id`, "unknown_id", "Try: aifirst at py-7-03");
}
