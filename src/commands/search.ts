/**
 * `aifirst search "<prompt text>"`.
 *
 * How an agent resolves a prompt a learner typed or pasted from the printed page
 * into the canonical exercise. Uses the shared matcher, so a given prompt maps to
 * the same response here as it does in the VS Code extension.
 */

import { findMatchingStep } from "@aifirst/content";
import type { Args } from "../cli";
import { formatFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import { byId, exampleJson } from "../exercises";
import { read } from "../log/progress";
import { CliError, bold, cyan, dim, glyph, json, out } from "../output";

/** Accept the printable book tags as well as the VS Code language ids. */
function normalizeLanguage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const l = raw.toLowerCase();
  if (l === "py" || l === "python") return "python";
  if (l === "java") return "java";
  throw new CliError(`Unknown language "${raw}"`, "bad_option", "Use --language py or --language java");
}

export function search(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const query = args.positionals.join(" ").trim();
  if (!query) {
    throw new CliError("search needs some prompt text", "missing_argument", `Try: aifirst search "Write a Hello World app"`);
  }

  const language = normalizeLanguage(stringFlag(args, "language"));
  const { content } = resolveContent();
  const log = read();

  const step = findMatchingStep(query, content.steps, language);

  if (!step) {
    // A miss is a normal outcome, not a crash — the JSON body still parses, with
    // an explicit null match — but it exits non-zero in both formats so shell
    // callers can branch on it and the two formats never disagree.
    process.exitCode = 1;
    if (format === "json") {
      json({ match: null, query, language: language ?? null });
      return;
    }
    out();
    out(`  ${dim("No book example matches")} ${bold(query)}`);
    out(dim(`  ${glyph.arrow} aifirst list        browse what exists`));
    out();
    return;
  }

  const example = byId(content, step.exampleId)!;

  if (format === "json") {
    json({
      match: { ...exampleJson(example, log, [step]), matchedStepId: step.id },
      query,
      language: language ?? null,
    });
    return;
  }

  out();
  out(`  ${bold(example.title)}  ${dim(step.id)}`);
  out(`  ${dim(`${example.bookTitle} ${glyph.bullet} ${example.chapterTitle}`)}`);
  out();
  out(`  ${cyan("Prompt")}`);
  out(`  ${step.prompt}`);
  out();
  out(dim(`  ${glyph.arrow} aifirst show ${step.id}    see the canonical response`));
  out();
}
