/** Deterministic event oracles for real Claude authoring and local learning. */

import { basename } from "node:path";
import type { PlanQuestion, PlanWorkflow, RawBook } from "../../src/content/types";

export type CanonicalEvent =
  | { type: "text"; text: string }
  | {
      type: "question";
      question: string;
      header: string;
      options: Array<{
        label: string;
        description: string;
        recommended: boolean;
      }>;
      answer: string;
    }
  | { type: "plan"; plan: string }
  | { type: "approval" }
  | { type: "tool"; name: string; input: unknown }
  | {
      type: "result";
      command: string;
      exitCode: number;
      stdout?: string;
      stderr?: string;
    };

interface RawBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

interface RawBookStep {
  replay?: { workflow?: PlanWorkflow };
}

interface RawShowtailEvent {
  type?: string;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  isError?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  plan?: string;
}

function normalize(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\/tmp\/(?:aifirst-[^/]+|tmp\.[^/]+)\/workspace/g, ".")
    .replace(/\\tmp\\(?:aifirst-[^\\]+|tmp\.[^\\]+)\\workspace/g, ".")
    .replace(/Ran (\d+) tests in \d+(?:\.\d+)?s/g, "Ran $1 tests in <time>s")
    .trim();
}

function stripRecommended(value: string): string {
  return value.replace(/\s*\((?:Book )?Recommended\)\s*$/i, "").trim();
}

function workflows(book: RawBook): PlanWorkflow[] {
  const example = book.sections[0]?.chapters[0]?.examples[0];
  return ((example?.prompts ?? []) as RawBookStep[]).flatMap((step) =>
    step.replay?.workflow ? [step.replay.workflow] : [],
  );
}

function workflowQuestion(
  available: PlanWorkflow[],
  question: string,
): { workflow: PlanWorkflow; question: PlanQuestion } {
  for (const workflow of available) {
    const found = workflow.questions.find(
      (candidate) => candidate.question === question,
    );
    if (found) return { workflow, question: found };
  }
  throw new Error(`No generated workflow question matches: ${question}`);
}

function canonicalQuestion(
  workflow: PlanWorkflow,
  question: PlanQuestion,
): Extract<CanonicalEvent, { type: "question" }> {
  const selected = workflow.canonicalAnswers[question.id];
  const answer = question.options.find((option) => option.id === selected);
  if (!answer)
    throw new Error(`Canonical answer ${selected} is missing for ${question.id}`);
  return {
    type: "question",
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({
      label: option.label,
      description: normalize(option.description),
      recommended: option.id === selected,
    })),
    answer: answer.label,
  };
}

function relativeToolPath(raw: string, sourcePaths: string[]): string {
  const normalized = raw.replace(/\\/g, "/");
  const match = sourcePaths
    .filter(
      (candidate) =>
        normalized === candidate || normalized.endsWith(`/${candidate}`),
    )
    .sort((left, right) => right.length - left.length)[0];
  return match ?? basename(normalized);
}

function unwrapCommand(command: string): string {
  const match = /^bash -lc '([\s\S]*)'$/.exec(command);
  let normalized = (match?.[1] ?? command)
    .replace(/'\\''/g, "'")
    .replace(/\\\r?\n/g, "");
  normalized = normalized.replace(
    /^([^\n]+);\s*echo (["'])exit=\$\?\2$/gm,
    (_matched, invocation: string, quote: string) =>
      `${invocation} || AIFIRST_REPLAY_STATUS=$?; echo ${quote}exit=\${AIFIRST_REPLAY_STATUS:-0}${quote}; unset AIFIRST_REPLAY_STATUS`,
  );
  const unixRoots = [
    ...normalized.matchAll(/\/tmp\/aifirst-[^/\s'"]+\/workspace/g),
  ].map((candidate) => candidate[0]);
  const directoryTargets = [
    ...normalized.matchAll(/\bcd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g),
  ].map((candidate) => candidate[1]!.replace(/^['"]|['"]$/g, ""));
  const changesDirectory = directoryTargets.some(
    (target) => !unixRoots.some((root) => target.includes(root)),
  );
  if (changesDirectory && unixRoots.length > 0) {
    for (const root of new Set(unixRoots))
      normalized = normalized.split(root).join('"$AIFIRST_REPLAY_ROOT"');
    normalized = `AIFIRST_REPLAY_ROOT=$(pwd)\n${normalized}`;
  }
  return normalize(normalized);
}

function canonicalTool(
  name: string,
  input: Record<string, unknown>,
  sourcePaths: string[],
): Extract<CanonicalEvent, { type: "tool" }> | undefined {
  const lower = name.toLowerCase();
  if (["write", "read", "edit"].includes(lower)) {
    const rawPath = String(input.file_path ?? input.path ?? "");
    if (!rawPath) return undefined;
    const path = relativeToolPath(rawPath, sourcePaths);
    if (!sourcePaths.includes(path)) return undefined;
    if (lower === "write")
      return {
        type: "tool",
        name: "Write",
        input: { path, content: normalize(String(input.content ?? "")) },
      };
    if (lower === "read")
      return { type: "tool", name: "Read", input: { path } };
    return {
      type: "tool",
      name: "Edit",
      input: {
        path,
        oldText: normalize(String(input.old_string ?? input.oldText ?? "")),
        newText: normalize(String(input.new_string ?? input.newText ?? "")),
        replaceAll: input.replace_all === true || input.replaceAll === true,
      },
    };
  }
  if (lower === "bash")
    return {
      type: "tool",
      name: "Bash",
      input: { command: unwrapCommand(String(input.command ?? "")) },
    };
  return undefined;
}

function canonicalBashResult(
  command: string,
  result: Record<string, unknown>,
  isError?: boolean,
): Extract<CanonicalEvent, { type: "result" }> {
  const normalizedCommand = unwrapCommand(command);
  const dynamicPreflight = /(?:^|&&\s*)ls\s+-la(?:\s|$)/.test(
    normalizedCommand,
  );
  const directoryReset = normalizedCommand.includes("AIFIRST_REPLAY_ROOT=$(pwd)");
  return {
    type: "result",
    command: normalizedCommand,
    exitCode:
      isError === false ? 0 : Number(result.exitCode ?? result.exit_code ?? 1),
    ...(!dynamicPreflight
      ? {
          stdout: normalize(String(result.stdout ?? "")),
          ...(!directoryReset
            ? { stderr: normalize(String(result.stderr ?? "")) }
            : {}),
        }
      : {}),
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function canonicalAuthorEvents(
  rawReport: unknown,
  book: RawBook,
  sourcePaths: string[],
): CanonicalEvent[] {
  const report = object(rawReport);
  const turns = Array.isArray(report.turns) ? report.turns : [];
  const available = workflows(book);
  const out: CanonicalEvent[] = [];
  for (const rawTurn of turns) {
    const turn = object(rawTurn);
    const events = Array.isArray(turn.events)
      ? (turn.events as RawShowtailEvent[])
      : [];
    const results = new Map(
      events
        .filter((event) => event.type === "tool_result" && event.toolUseId)
        .map((event) => [event.toolUseId!, event]),
    );
    for (const event of events) {
      if (event.type === "assistant_text" && event.text) {
        out.push({ type: "text", text: normalize(event.text) });
        continue;
      }
      if (event.type === "plan_snapshot" && event.plan) {
        out.push({ type: "plan", plan: normalize(event.plan) });
        continue;
      }
      if (event.type === "plan_approved") {
        out.push({ type: "approval" });
        continue;
      }
      if (event.type !== "tool_use" || !event.toolName) continue;
      if (event.toolName.toLowerCase() === "askuserquestion") {
        const questions = Array.isArray(event.input?.questions)
          ? event.input!.questions
          : [];
        for (const candidate of questions) {
          const text = String(object(candidate).question ?? "");
          const match = workflowQuestion(available, text);
          out.push(canonicalQuestion(match.workflow, match.question));
        }
        continue;
      }
      const tool = canonicalTool(event.toolName, event.input ?? {}, sourcePaths);
      if (!tool) continue;
      out.push(tool);
      if (tool.name === "Bash") {
        const result = event.toolUseId ? results.get(event.toolUseId) : undefined;
        out.push(
          canonicalBashResult(
            String(event.input?.command ?? ""),
            object(result),
            result?.isError,
          ),
        );
      }
    }
  }
  return out;
}

function verifyRenderedQuestion(
  block: RawBlock,
  expected: Extract<CanonicalEvent, { type: "question" }>,
): void {
  const rawQuestion = Array.isArray(block.input?.questions)
    ? object(block.input!.questions[0])
    : {};
  const options = Array.isArray(rawQuestion.options) ? rawQuestion.options : [];
  if (options.length !== expected.options.length)
    throw new Error(`Rendered option count differs for ${expected.question}`);
  expected.options.forEach((option, index) => {
    const rendered = object(options[index]);
    const label = String(rendered.label ?? "");
    if (stripRecommended(label) !== option.label)
      throw new Error(`Rendered option differs for ${expected.question}: ${label}`);
    if (option.recommended !== /\(Book Recommended\)$/i.test(label))
      throw new Error(`Book recommendation differs for ${expected.question}: ${label}`);
    if (normalize(String(rendered.description ?? "")) !== option.description)
      throw new Error(`Rendered description differs for ${expected.question}`);
  });
}

function verifyRenderedQuestionText(
  text: string,
  expected: Extract<CanonicalEvent, { type: "question" }>,
): void {
  for (const option of expected.options) {
    const label = `${option.label}${option.recommended ? " (Book Recommended)" : ""}`;
    if (!text.includes(label) || !text.includes(option.description))
      throw new Error(`Rendered text option differs for ${expected.question}: ${label}`);
  }
}

export function canonicalLearnEvents(
  raw: string,
  book: RawBook,
  sourcePaths: string[],
): CanonicalEvent[] {
  const available = workflows(book);
  const plans = new Set<PlanWorkflow>();
  const renderedQuestions = new Set<PlanQuestion>();
  const tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  const out: CanonicalEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      const message = object(event.message);
      const content = Array.isArray(message.content)
        ? (message.content as RawBlock[])
        : [];
      for (const block of content) {
        if (block.type === "tool_use" && block.name && block.id) {
          tools.set(block.id, { name: block.name, input: block.input ?? {} });
          if (block.name.toLowerCase() === "askuserquestion") {
            if (block.id.includes("_approval_")) continue;
            const questionText = String(
              object(
                Array.isArray(block.input?.questions)
                  ? block.input!.questions[0]
                  : undefined,
              ).question ?? "",
            );
            const match = workflowQuestion(available, questionText);
            const expected = canonicalQuestion(match.workflow, match.question);
            verifyRenderedQuestion(block, expected);
            out.push(expected);
            continue;
          }
          const tool = canonicalTool(block.name, block.input ?? {}, sourcePaths);
          if (tool) out.push(tool);
          continue;
        }
        if (block.type !== "text" || !block.text) continue;
        const text = normalize(block.text);
        const fallbackQuestion = available
          .flatMap((workflow) =>
            workflow.questions.map((question) => ({ workflow, question })),
          )
          .find(
            ({ question }) =>
              !renderedQuestions.has(question) &&
              text.includes(question.question) &&
              text.includes("Book Recommended"),
          );
        if (fallbackQuestion) {
          const expected = canonicalQuestion(
            fallbackQuestion.workflow,
            fallbackQuestion.question,
          );
          verifyRenderedQuestionText(text, expected);
          const prefix = text
            .slice(0, text.indexOf(fallbackQuestion.question.question))
            .trim();
          if (prefix) out.push({ type: "text", text: prefix });
          out.push(expected);
          renderedQuestions.add(fallbackQuestion.question);
          continue;
        }
        const workflow = available.find(
          (candidate) =>
            !plans.has(candidate) && text.includes(candidate.canonicalPlan),
        );
        if (workflow && text.includes("## Proposed plan")) {
          const prefix = text.slice(0, text.indexOf("## Proposed plan")).trim();
          if (prefix) out.push({ type: "text", text: prefix });
          out.push({ type: "plan", plan: normalize(workflow.canonicalPlan) });
          out.push({ type: "approval" });
          plans.add(workflow);
        } else {
          out.push({ type: "text", text });
        }
      }
    } else if (event.type === "user") {
      const message = object(event.message);
      const content = Array.isArray(message.content)
        ? (message.content as RawBlock[])
        : [];
      for (const block of content) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const tool = tools.get(block.tool_use_id);
        if (tool?.name.toLowerCase() !== "bash") continue;
        out.push(
          canonicalBashResult(
            String(tool.input.command ?? ""),
            object(event.tool_use_result ?? event.toolUseResult ?? block.content),
            block.is_error,
          ),
        );
      }
    }
  }
  return out;
}

export function firstEventDifference(
  expected: CanonicalEvent[],
  actual: CanonicalEvent[],
): string {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index]))
      return `event ${index}\nexpected: ${JSON.stringify(expected[index], null, 2)}\nactual: ${JSON.stringify(actual[index], null, 2)}`;
  }
  return "none";
}
