/**
 * Line diff, for comparing a learner's file against the book's code.
 *
 * Hand-rolled rather than shelling out to `diff`, because the whole point is that
 * an assistant should not need a shell pipeline to answer "does this match the
 * book?" — the version that prompted this wrote a temp file and used process
 * substitution, which lands the learner in an approval prompt mid-exercise.
 *
 * Longest-common-subsequence, which is O(n*m). Exercises are tens of lines, so the
 * quadratic table costs nothing and the output is stable and easy to read.
 */

export type DiffOp = "same" | "removed" | "added";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the file being compared, when present there. */
  yours?: number;
  /** 1-based line number in the book's code, when present there. */
  book?: number;
}

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Full line-by-line alignment of `yours` against `book`. */
export function diffLines(yours: string, book: string): DiffLine[] {
  const a = yours.split("\n");
  const b = book.split("\n");
  const table = lcsTable(a, b);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i], yours: i + 1, book: j + 1 });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ op: "removed", text: a[i], yours: i + 1 });
      i++;
    } else {
      out.push({ op: "added", text: b[j], book: j + 1 });
      j++;
    }
  }
  while (i < a.length) out.push({ op: "removed", text: a[i], yours: ++i });
  while (j < b.length) out.push({ op: "added", text: b[j], book: ++j });
  return out;
}

/**
 * Drop long runs of unchanged lines, keeping `context` on each side.
 *
 * A learner comparing a 60-line program against the book wants the three lines
 * that differ, not the 57 that do not.
 */
export function condense(lines: DiffLine[], context = 2): (DiffLine | "gap")[] {
  const keep = new Set<number>();
  lines.forEach((line, n) => {
    if (line.op === "same") return;
    for (let k = Math.max(0, n - context); k <= Math.min(lines.length - 1, n + context); k++) keep.add(k);
  });

  const out: (DiffLine | "gap")[] = [];
  let skipping = false;
  lines.forEach((line, n) => {
    if (keep.has(n)) {
      out.push(line);
      skipping = false;
    } else if (!skipping) {
      out.push("gap");
      skipping = true;
    }
  });
  return out;
}

/** Trailing-newline differences are not a mismatch a reader should be shown. */
export function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}
