#!/usr/bin/env bun
/**
 * aifirst — entry point and command dispatch.
 */

import { parse, boolFlag, formatFlag } from "./cli";
import type { Args } from "./cli";
import { apply } from "./commands/apply";
import { at } from "./commands/at";
import { book } from "./commands/book";
import { bookMode } from "./commands/bookmode";
import { diff } from "./commands/diff";
import { doctor } from "./commands/doctor";
import { help } from "./commands/help";
import { init } from "./commands/init";
import { list } from "./commands/list";
import { learn } from "./commands/learn";
import { done, reset, skip } from "./commands/mark";
import { next } from "./commands/next";
import { progress } from "./commands/progress";
import { run } from "./commands/run";
import { search } from "./commands/search";
import { serve } from "./commands/serve";
import { show, prompt } from "./commands/show";
import { skill } from "./commands/skill";
import { update } from "./commands/update";
import { CliError, out, reportError } from "./output";
import { VERSION } from "./version";

type Handler = (args: Args) => void | Promise<void>;

const COMMANDS: Record<string, Handler> = {
  init,
  doctor,
  list,
  ls: list,
  learn,
  next,
  show,
  prompt,
  apply,
  at,
  where: at,
  diff,
  compare: diff,
  run,
  book,
  books: book,
  "book-mode": bookMode,
  bookmode: bookMode,
  search,
  find: search,
  serve,
  done,
  skip,
  reset,
  progress,
  skill,
  skills: skill,
  update,
  help: () => help(),
};

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parse(argv);
  } catch (e) {
    reportError(e, "text");
    return 1;
  }

  if (boolFlag(args, "version") || args.command === "version") {
    out(VERSION);
    return 0;
  }

  if (!args.command || boolFlag(args, "help")) {
    help();
    return args.command ? 0 : 0;
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    // Suggest the closest command rather than just dumping help: a mistyped
    // exercise id as the first argument is a common beginner slip.
    const suggestion = closest(args.command, Object.keys(COMMANDS));
    reportError(
      new CliError(
        `Unknown command "${args.command}"`,
        "unknown_command",
        suggestion ? `Did you mean "aifirst ${suggestion}"?` : "Run: aifirst help",
      ),
      safeFormat(args),
    );
    return 1;
  }

  try {
    await handler(args);
    return process.exitCode ? Number(process.exitCode) : 0;
  } catch (e) {
    reportError(e, safeFormat(args));
    return 1;
  }
}

/** Never let a bad --format value mask the error we're trying to report. */
function safeFormat(args: Args): "text" | "json" {
  try {
    const f = formatFlag(args, ["text", "json", "md"]);
    return f === "json" ? "json" : "text";
  } catch {
    return "text";
  }
}

/** Levenshtein distance, for "did you mean" on a typo'd command. */
function closest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = distance(input, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return bestScore <= 2 ? best : undefined;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

// Only run when executed directly, so tests can import main() without dispatching.
//
// Deliberately not top-level await: `bun build --bytecode` emits CommonJS, which
// cannot represent it, and bytecode is what keeps CLI startup fast.
if (import.meta.main) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      reportError(e, "text");
      process.exitCode = 1;
    },
  );
}
