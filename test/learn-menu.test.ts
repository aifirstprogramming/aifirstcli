import { describe, expect, test } from "bun:test";
import { resolveContent } from "../src/content";
import { chapterLabel, exerciseLabel, learnChapters, lookupExercise } from "../src/learn/menu";
import type { ProgressLog } from "../src/log/progress";

const content = resolveContent().content;
const python = content.books.find((book) => book.tag === "py")!;
const pythonScope = { kind: "book" as const, book: python };

describe("learn menu exercise lookup", () => {
  test("resolves full ids and selected-book shorthand directly", () => {
    expect(lookupExercise("py-2-01", content, pythonScope)).toMatchObject({
      kind: "exercise",
      example: { id: "py-2-01" },
    });
    expect(lookupExercise("2.1", content, pythonScope)).toMatchObject({
      kind: "exercise",
      example: { id: "py-2-01" },
    });
    expect(lookupExercise("2-1", content, pythonScope)).toMatchObject({
      kind: "exercise",
      example: { id: "py-2-01" },
    });
  });

  test("lets an explicit full id identify its owning book", () => {
    expect(lookupExercise("java-2-01", content, pythonScope)).toMatchObject({
      kind: "exercise",
      example: { id: "java-2-01" },
    });
  });

  test("makes shorthand explicit when all books contain it", () => {
    const result = lookupExercise("2.1", content, { kind: "all" });
    expect(result.kind).toBe("matches");
    if (result.kind === "matches") {
      expect(result.examples.map((example) => example.id)).toEqual(["java-2-01", "py-2-01"]);
    }
  });

  test("returns title and prompt searches as reviewable matches", () => {
    expect(lookupExercise("Basket of Fruits", content, pythonScope)).toMatchObject({
      kind: "matches",
      examples: [{ id: "py-2-01" }],
    });
    expect(lookupExercise("Write a six line program with three baskets", content, pythonScope)).toMatchObject({
      kind: "matches",
      examples: [{ id: "py-2-01" }],
    });
  });

  test("rejects short fuzzy queries instead of matching language fragments", () => {
    expect(lookupExercise("py", content, pythonScope)).toEqual({ kind: "none" });
    expect(lookupExercise("ai", content, pythonScope)).toEqual({ kind: "none" });
  });
});

describe("learn menu progress labels", () => {
  test("keeps empty chapters visible and reports chapter status", () => {
    const log: ProgressLog = {
      version: 1,
      exercises: {
        "py-2-01": { status: "done", at: "2026-01-01T00:00:00.000Z", via: "run" },
        "py-2-08": { status: "skipped", at: "2026-01-01T00:00:00.000Z", via: "self" },
      },
    };
    const views = learnChapters(content, log, pythonScope);
    const chapter2 = views.find((chapter) => chapter.view.number === 2)!;
    const chapter8 = views.find((chapter) => chapter.view.number === 8)!;

    expect(chapter2.counts.done).toBe(1);
    expect(chapter2.counts.skipped).toBe(1);
    expect(chapterLabel(chapter2)).toContain("1/6, 1 skipped");
    expect(chapterLabel(chapter8)).toContain("no exercises published yet");
    expect(exerciseLabel(chapter2.view.examples[0], log)).toContain("py-2-01");
  });
});
