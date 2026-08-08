/**
 * Which book a command should act on.
 *
 * Readers own one book of a growing series, so showing them another book's
 * exercises is noise at best and misleading at worst — the original release
 * handed Python readers Java exercises simply because "java" sorts first.
 *
 * Three states, and the difference between the last two matters:
 *  - a specific book
 *  - `all`, chosen deliberately
 *  - **unset**, which is not a default. Nothing guesses; commands surface it so
 *    the learner (or their assistant) is asked.
 */

import { ALL_BOOKS, read as readConfig } from "./config";
import type { Book, Content } from "./content/types";
import { CliError } from "./output";

export type Scope =
  | { kind: "unset" }
  | { kind: "all" }
  | { kind: "book"; book: Book };

/**
 * Resolve a book selector: tag ("py"), id, or a distinctive part of the title.
 * Also accepts "all".
 */
export function selectBook(content: Content, selector: string): Book | "all" {
  const s = selector.trim().toLowerCase();
  if (s === ALL_BOOKS || s === "both") return "all";

  const byTag = content.books.find((b) => b.tag.toLowerCase() === s);
  if (byTag) return byTag;

  const byLanguage = content.books.find((b) => b.language.toLowerCase() === s);
  if (byLanguage) return byLanguage;

  const byId = content.books.find((b) => b.id.toLowerCase() === s);
  if (byId) return byId;

  const partial = content.books.filter(
    (b) => b.id.toLowerCase().includes(s) || b.title.toLowerCase().includes(s),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new CliError(`"${selector}" matches ${partial.length} books`, "ambiguous_book", choices(content));
  }
  throw new CliError(`No book matches "${selector}"`, "unknown_book", choices(content));
}

function choices(content: Content): string {
  return `Available: ${content.books.map((b) => b.tag).join(", ")}, or all`;
}

/**
 * The scope for this invocation: an explicit override if given, else the stored
 * choice, else unset.
 */
export function resolveScope(
  content: Content,
  options: { selector?: string; all?: boolean; configPath?: string } = {},
): Scope {
  if (options.all) return { kind: "all" };

  if (options.selector) {
    const picked = selectBook(content, options.selector);
    return picked === "all" ? { kind: "all" } : { kind: "book", book: picked };
  }

  const stored = readConfig(options.configPath).book;
  if (!stored) return { kind: "unset" };
  if (stored === ALL_BOOKS) return { kind: "all" };

  const book = content.books.find((b) => b.id === stored || b.tag === stored);
  // A stored book that this pack no longer contains shouldn't wedge the CLI;
  // fall back to asking again.
  return book ? { kind: "book", book } : { kind: "unset" };
}

/** Does this scope include the given book? */
export function inScope(scope: Scope, bookId: string): boolean {
  if (scope.kind === "book") return scope.book.id === bookId;
  // "unset" includes everything: a listing still works before a choice is made,
  // it just isn't narrowed.
  return true;
}

/** Books offered when asking the learner to choose, in a stable order. */
export function bookChoices(content: Content): { id: string; tag: string; title: string; language: string; exercises: number }[] {
  return content.books.map((b) => ({
    id: b.id,
    tag: b.tag,
    title: b.title,
    language: b.language,
    exercises: b.sections.flatMap((s) => s.chapters).flatMap((c) => c.examples).length,
  }));
}
