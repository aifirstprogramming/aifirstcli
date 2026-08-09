/**
 * Re-exports of the shared content types, so the rest of the CLI imports from
 * one place and the dependency on @aifirst/content stays visible at the seam.
 */

export type {
  Book,
  Chapter,
  Content,
  Example,
  Explanation,
  Language,
  RawBook,
  Scaffold,
  Section,
  Step,
} from "@aifirst/content";

export interface RawEntry {
  filename: string;
  book: import("@aifirst/content").RawBook;
}
