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
import type { Content, Example, Step } from "./content/types";
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
 */
export function next(content: Content, log: ProgressLog, bookId?: string): Example | null {
  for (const ex of ordered(content)) {
    if (bookId && ex.bookId !== bookId) continue;
    if (!log.exercises[ex.id]) return ex;
  }
  return null;
}

export interface Counts {
  total: number;
  done: number;
  skipped: number;
  remaining: number;
  /** Fraction of authored exercises done, 0..1. NaN-free even when total is 0. */
  fraction: number;
}

function tally(examples: Example[], log: ProgressLog): Counts {
  let done = 0;
  let skipped = 0;
  for (const ex of examples) {
    const e = log.exercises[ex.id];
    if (e?.status === "done") done++;
    else if (e?.status === "skipped") skipped++;
  }
  const total = examples.length;
  return {
    total,
    done,
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

export function report(content: Content, log: ProgressLog): ProgressReport {
  const books: BookProgress[] = content.books.map((book) => {
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

  return { overall: tally(content.examples, log), books };
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
