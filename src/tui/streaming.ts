import { marked } from "marked";

export interface MarkdownStreamBlock {
  raw: string;
  immediate: boolean;
}

/** Keep top-level Markdown boundaries so one keypress skips only the active block. */
export function markdownStreamBlocks(markdown: string): MarkdownStreamBlock[] {
  return marked.lexer(markdown, { gfm: true })
    .filter((token) => token.raw.length > 0)
    .map((token) => ({
      raw: token.raw,
      immediate: token.type === "heading" || token.type === "hr" || token.type === "space",
    }));
}

/** Split without losing Markdown syntax, preferring whitespace near the target size. */
export function streamChunks(value: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = Array.from(value);
  const size = Math.max(1, Math.floor(limit));
  while (remaining.length > size) {
    let end = size;
    for (let index = size; index >= Math.ceil(size / 2); index--) {
      if (/\s/.test(remaining[index - 1] ?? "")) {
        end = index;
        break;
      }
    }
    chunks.push(remaining.slice(0, end).join(""));
    remaining = remaining.slice(end);
  }
  if (remaining.length > 0) chunks.push(remaining.join(""));
  return chunks;
}

export function streamDelayMs(fragment: string, charsPerSecond: number): number {
  return Math.max(1, Math.round((Array.from(fragment).length / Math.max(1, charsPerSecond)) * 1000));
}
