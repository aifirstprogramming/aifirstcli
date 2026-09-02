import { mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { exercisePath, resolve as resolveExercise } from "@aifirst/content";
import { ALL_BOOKS, setWorkspace, workspaceFor } from "./config";
import { resolveScope, selectBook } from "./books";
import type { Book, Content, Example, Step } from "./content/types";
import { home } from "./paths";
import { CliError } from "./output";

export interface WorkspaceResolution {
  key: string;
  path: string;
  book?: Book;
}

export function ensureWorkspace(content: Content, key: string): WorkspaceResolution {
  const book = content.books.find((candidate) => candidate.tag === key || candidate.id === key);
  const normalizedKey = book?.tag ?? key;
  const saved = workspaceFor(normalizedKey);
  const path = resolvePath(saved ?? join(home(), "aifirst", normalizedKey));
  mkdirSync(path, { recursive: true });
  if (!saved) setWorkspace(normalizedKey, path);
  return { key: normalizedKey, path, ...(book ? { book } : {}) };
}

export function workspaceForExample(content: Content, example: Example): WorkspaceResolution {
  const book = content.books.find((candidate) => candidate.id === example.bookId);
  if (!book) throw new CliError(`No book owns ${example.id}`, "unknown_book");
  return ensureWorkspace(content, book.tag);
}

export function defaultExercisePath(content: Content, example: Example, step: Step): string {
  return join(workspaceForExample(content, example).path, exercisePath(example, step));
}

export function resolveWorkspace(content: Content, selector?: string): WorkspaceResolution {
  if (selector) {
    const directBook = content.books.find((book) =>
      book.tag.toLowerCase() === selector.toLowerCase() ||
      book.id.toLowerCase() === selector.toLowerCase() ||
      book.language.toLowerCase() === selector.toLowerCase()
    );
    if (directBook) return ensureWorkspace(content, directBook.tag);
    if (selector === ALL_BOOKS || selector.toLowerCase() === "both") return ensureWorkspace(content, ALL_BOOKS);
    try {
      return workspaceForExample(content, resolveExercise(selector, content).example);
    } catch {
      const picked = selectBook(content, selector);
      return ensureWorkspace(content, picked === "all" ? ALL_BOOKS : picked.tag);
    }
  }

  const scope = resolveScope(content);
  if (scope.kind === "book") return ensureWorkspace(content, scope.book.tag);
  if (scope.kind === "all") return ensureWorkspace(content, ALL_BOOKS);
  throw new CliError(
    "Choose a book or provide an exercise id to resolve its workspace",
    "book_choice_required",
    `Try: aifirst workspace ${content.books[0]?.tag ?? "py"}`,
  );
}
