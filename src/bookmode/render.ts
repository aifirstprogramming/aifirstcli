import { exercisePath } from "@aifirst/content";
import type { Example, Step } from "../content/types";

function fence(language: string): string {
  return language === "java" ? "java" : "python";
}

/** Render stored learning material in the order a reader uses it. */
export function renderStep(example: Example, step: Step): string {
  const parts = [
    `**${example.title}**  ·  ${example.id}`,
    `${example.bookTitle} - ${example.chapterTitle}`,
    "",
    "## Code",
    "",
    `\`\`\`${fence(example.language)}`,
    step.response,
    "```",
    "",
    "## Explanation",
    "",
    "This content-library walkthrough is stored with the exercise.",
  ];

  if (step.explanation) {
    parts.push("", step.explanation.summary);
    for (const line of step.explanation.lines) {
      parts.push("", `- \`${line.code.trim()}\`: ${line.text}`);
    }
  }

  parts.push("", `Writing it to \`${exercisePath(example, step)}\` and running it.`);
  return parts.join("\n");
}
