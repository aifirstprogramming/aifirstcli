/**
 * Selection and progress arithmetic shared by the commands.
 *
 * One rule governs all of it: **only authored exercises count.** Both books have
 * chapters written ahead of their examples, so counting declared chapters would
 * tell a learner they're "0% through 22 chapters" when they've finished
 * everything that exists. Empty chapters are still listed — they preview what's
 * coming — but they never enter a denominator and `next` skips them.
 */

import { compareIds } from "@aifirst/content";
import { inScope } from "./books";
import type { Scope } from "./books";
import type { Content, Dependency, Example, Explanation, Step } from "./content/types";
import type { Entry, ProgressLog } from "./log/progress";

/** All examples in stable id order. */
export function ordered(content: Content): Example[] {
  return [...content.examples].sort((a, b) => compareIds(a.id, b.id));
}

export function byId(content: Content, id: string): Example | undefined {
  return content.examples.find((e) => e.id === id);
}

export interface ChapterView {
  bookId: string;
  bookTitle: string;
  sectionTitle: string;
  title: string;
  number: number;
  goal?: string;
  examples: Example[];
}

/** Flatten to chapters, preserving document order and keeping empty ones. */
export function chapters(content: Content): ChapterView[] {
  const out: ChapterView[] = [];
  for (const book of content.books) {
    for (const section of book.sections) {
      for (const chapter of section.chapters) {
        out.push({
          bookId: book.id,
          bookTitle: book.title,
          sectionTitle: section.title,
          title: chapter.title,
          number: chapter.number,
          goal: chapter.goal,
          examples: chapter.examples,
        });
      }
    }
  }
  return out;
}

/**
 * The next exercise to work on: the first authored example, in id order, with no
 * log entry. A skipped exercise counts as handled and is not offered again.
 *
 * Never crosses out of `scope`. Finishing a book is an achievement to report, not
 * a cue to silently start a different book the reader may not even own.
 */
export function next(content: Content, log: ProgressLog, scope: Scope): Example | null {
  return resume(content, log, scope).example;
}

export interface Resume {
  /** The exercise to offer, or null when everything in scope is handled. */
  example: Example | null;
  /**
   * Unfinished exercises that sit *before* the bookmark and are being passed
   * over. Reported rather than silently skipped: a learner who left gaps should
   * be told they exist, not discover them at the end of the book.
   */
  earlierUnfinished: number;
  /** The bookmark this resumed from, when there was one. */
  from?: string;
}

/**
 * The next exercise to work on, resuming from where the learner is.
 *
 * Strict id order was the original rule, and it meant someone working through
 * chapter 7 was handed a chapter 2 exercise every time they asked what was next —
 * the earliest gap always won. Reading a book does not work that way: you are
 * where you are, whether or not you did every exercise behind you.
 *
 * So the search starts at the bookmark and only falls back to the earliest gap
 * when there is nothing left ahead. Passing `earliest` restores the old rule for
 * a learner who does want to sweep up what they missed.
 */
export function resume(
  content: Content,
  log: ProgressLog,
  scope: Scope,
  options: { earliest?: boolean } = {},
): Resume {
  const inBook = ordered(content).filter((e) => inScope(scope, e.bookId));
  const unfinished = inBook.filter((e) => !log.exercises[e.id]);
  if (unfinished.length === 0) return { example: null, earlierUnfinished: 0 };

  const from = log.position;
  if (options.earliest || !from) return { example: unfinished[0], earlierUnfinished: 0 };

  const ahead = unfinished.filter((e) => compareIds(e.id, from) >= 0);
  if (ahead.length === 0) {
    // Nothing left ahead: fall back rather than claiming the book is finished.
    return { example: unfinished[0], earlierUnfinished: 0, from };
  }
  return {
    example: ahead[0],
    earlierUnfinished: unfinished.length - ahead.length,
    from,
  };
}

export interface Counts {
  total: number;
  done: number;
  variants: number;
  skipped: number;
  remaining: number;
  /** Fraction of authored exercises done, 0..1. NaN-free even when total is 0. */
  fraction: number;
}

function tally(examples: Example[], log: ProgressLog): Counts {
  let done = 0;
  let variants = 0;
  let skipped = 0;
  for (const ex of examples) {
    const e = log.exercises[ex.id];
    if (e?.status === "done") {
      done++;
      if (e.variant) variants++;
    }
    else if (e?.status === "skipped") skipped++;
  }
  const total = examples.length;
  return {
    total,
    done,
    variants,
    skipped,
    remaining: total - done - skipped,
    fraction: total === 0 ? 0 : done / total,
  };
}

export interface BookProgress {
  bookId: string;
  bookTitle: string;
  language: string;
  counts: Counts;
  chapters: {
    number: number;
    title: string;
    counts: Counts;
    /** True when the chapter has no authored examples yet. */
    empty: boolean;
  }[];
}

export interface ProgressReport {
  overall: Counts;
  books: BookProgress[];
}

/**
 * Progress over the books in scope.
 *
 * A reader who owns one book should see a denominator they can actually finish,
 * not one inflated by a book they don't have.
 */
export function report(content: Content, log: ProgressLog, scope: Scope = { kind: "all" }): ProgressReport {
  const scoped = content.books.filter((b) => inScope(scope, b.id));
  const books: BookProgress[] = scoped.map((book) => {
    const chapterViews = book.sections.flatMap((s) => s.chapters);
    const examples = chapterViews.flatMap((c) => c.examples);
    return {
      bookId: book.id,
      bookTitle: book.title,
      language: book.language,
      counts: tally(examples, log),
      chapters: chapterViews.map((c) => ({
        number: c.number,
        title: c.title,
        counts: tally(c.examples, log),
        empty: c.examples.length === 0,
      })),
    };
  });

  const inScopeExamples = content.examples.filter((e) => inScope(scope, e.bookId));
  return { overall: tally(inScopeExamples, log), books };
}

// ---------------------------------------------------------------------------
// Serialization for --format json (the agent-facing contract)
// ---------------------------------------------------------------------------

export interface StepJson {
  id: string;
  index: number;
  total: number;
  prompt: string;
  response: string;
  /**
   * The book's own walkthrough, pre-computed and shipped in the content pack.
   *
   * Passed through so an assistant presents the same words a reader would see in
   * the VS Code extension, which has no model and cannot write one.
   */
  explanation?: Explanation;
}

export interface ExampleJson {
  id: string;
  title: string;
  description?: string;
  language: string;
  book: { id: string; title: string };
  section: string;
  chapter: { number: number; title: string };
  multiStep: boolean;
  dependencies?: Dependency[];
  /** The prompt/response pairs, in order. Reproduce `response` verbatim. */
  steps: StepJson[];
  progress: Entry | null;
}

export function stepJson(step: Step): StepJson {
  return {
    id: step.id,
    index: step.index,
    total: step.total,
    prompt: step.prompt,
    response: step.response,
    ...(step.explanation ? { explanation: step.explanation } : {}),
  };
}

export function exampleJson(example: Example, log: ProgressLog, steps = example.steps): ExampleJson {
  return {
    id: example.id,
    title: example.title,
    ...(example.description ? { description: example.description } : {}),
    language: example.language,
    book: { id: example.bookId, title: example.bookTitle },
    section: example.sectionTitle,
    chapter: { number: example.chapterNumber, title: example.chapterTitle },
    multiStep: example.multiStep,
    ...(example.dependencies ? { dependencies: example.dependencies } : {}),
    steps: steps.map(stepJson),
    progress: log.exercises[example.id] ?? null,
  };
}

/**
 * The response a learner should end up with for a whole example.
 *
 * Multi-step examples are progressive — each step modifies the previous result —
 * so the final step is the finished program. Applying an earlier step's code as
 * "the answer" would hand back a half-built version.
 */
export function finalResponse(example: Example): Step {
  return example.steps[example.steps.length - 1];
}
