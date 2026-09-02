import { AmbiguousIdError, findMatchingStep, resolve } from "@aifirst/content";
import { inScope, type Scope } from "../books";
import type { Content, Example } from "../content/types";
import { chapters, report, type ChapterView, type Counts } from "../exercises";
import type { ProgressLog } from "../log/progress";
import { dim, glyph, green, yellow } from "../output";

export interface LearnChapter {
  view: ChapterView;
  counts: Counts;
}

export type ExerciseLookup =
  | { kind: "exercise"; example: Example }
  | { kind: "matches"; examples: Example[] }
  | { kind: "none" };

export function learnChapters(
  content: Content,
  log: ProgressLog,
  scope: Scope,
): LearnChapter[] {
  const counts = new Map<string, Counts>();
  for (const book of report(content, log, scope).books) {
    for (const chapter of book.chapters) counts.set(`${book.bookId}:${chapter.number}`, chapter.counts);
  }
  return chapters(content)
    .filter((chapter) => inScope(scope, chapter.bookId))
    .map((view) => ({
      view,
      counts: counts.get(`${view.bookId}:${view.number}`) ?? emptyCounts(view.examples.length),
    }));
}

export function chapterLabel(chapter: LearnChapter): string {
  if (chapter.view.examples.length === 0) {
    return `${dim(glyph.todo)} ${chapter.view.title} ${dim("- no exercises published yet")}`;
  }
  const marker = chapter.counts.done === chapter.counts.total
    ? green(glyph.done)
    : chapter.counts.done > 0 || chapter.counts.skipped > 0
      ? yellow(glyph.partial)
      : dim(glyph.todo);
  const skipped = chapter.counts.skipped > 0 ? `, ${chapter.counts.skipped} skipped` : "";
  return `${marker} ${chapter.view.title} ${dim(`- ${chapter.counts.done}/${chapter.counts.total}${skipped}`)}`;
}

export function exerciseLabel(example: Example, log: ProgressLog, includeBook = false): string {
  const entry = log.exercises[example.id];
  const marker = entry?.status === "done"
    ? green(glyph.done)
    : entry?.status === "skipped"
      ? yellow(glyph.skipped)
      : dim(glyph.todo);
  const book = includeBook ? `${example.bookTitle} ${glyph.bullet} ` : "";
  return `${marker} ${dim(example.id.padEnd(11))} ${example.title} ${dim(`- ${book}${example.chapterTitle}`)}`;
}

/** Resolve exact ids/shorthand directly; text searches always return a reviewable list. */
export function lookupExercise(
  input: string,
  content: Content,
  scope: Scope,
): ExerciseLookup {
  const raw = input.trim();
  if (!raw) return { kind: "none" };

  const shorthand = /^(\d+)[.-](\d+)$/.exec(raw);
  if (shorthand) {
    const candidates = content.books
      .filter((book) => inScope(scope, book.id))
      .map((book) => `${book.tag}-${Number(shorthand[1])}-${String(Number(shorthand[2])).padStart(2, "0")}`)
      .map((id) => content.examples.find((example) => example.id === id))
      .filter((example): example is Example => example !== undefined);
    if (candidates.length === 1) return { kind: "exercise", example: candidates[0] };
    if (candidates.length > 1) return { kind: "matches", examples: candidates };
    return { kind: "none" };
  }

  if (/^[a-z][a-z0-9]*-/i.test(raw)) {
    try {
      const hit = resolve(raw, content);
      return { kind: "exercise", example: hit.example };
    } catch (error) {
      if (error instanceof AmbiguousIdError) {
        const examples = uniqueExamples(
          error.candidates
            .map((id) => content.steps.find((step) => step.id === id)?.exampleId ?? id)
            .map((id) => content.examples.find((example) => example.id === id))
            .filter((example): example is Example => example !== undefined)
        );
        return examples.length > 0 ? { kind: "matches", examples } : { kind: "none" };
      }
      return { kind: "none" };
    }
  }

  const normalized = normalize(raw);
  if (normalized.replaceAll(" ", "").length < 3) return { kind: "none" };
  const words = normalized.split(" ").filter((word) => word.length > 2);
  const scoped = content.examples.filter((example) => inScope(scope, example.bookId));
  const exactTitles = scoped.filter((example) => normalize(example.title) === normalized);
  if (exactTitles.length > 0) return { kind: "matches", examples: exactTitles };

  const titleMatches = scoped.filter((example) => {
    const haystack = normalize(`${example.title} ${example.description ?? ""}`);
    return haystack.includes(normalized) || (words.length > 0 && words.every((word) => haystack.includes(word)));
  });
  if (titleMatches.length > 0) return { kind: "matches", examples: titleMatches.slice(0, 12) };

  const steps = content.steps.filter((step) => {
    const example = content.examples.find((candidate) => candidate.id === step.exampleId);
    return Boolean(example && inScope(scope, example.bookId));
  });
  const language = scope.kind === "book" ? scope.book.language : undefined;
  const step = findMatchingStep(raw, steps, language);
  const example = step ? content.examples.find((candidate) => candidate.id === step.exampleId) : undefined;
  return example ? { kind: "matches", examples: [example] } : { kind: "none" };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueExamples(examples: Example[]): Example[] {
  return [...new Map(examples.map((example) => [example.id, example])).values()];
}

function emptyCounts(total: number): Counts {
  return { total, done: 0, variants: 0, skipped: 0, remaining: total, fraction: 0 };
}
