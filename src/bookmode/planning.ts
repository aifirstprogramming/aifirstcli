import type { PlanQuestion, PlanVariant, Replay, ReplayEvent, ReplayStep } from "../content/types";

interface ContentBlock {
  type?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RequestMessage {
  role: string;
  content?: string | ContentBlock[];
}

interface ToolDefinition {
  name?: string;
}

export interface ActivePlanPath {
  stepId: string;
  kind: "canonical" | "authored";
  variantId?: string;
  answers: Record<string, string>;
  replay: Replay;
}

export interface PlanningSession {
  stepId?: string;
  replayMode?: "captured" | "standalone";
  expectedToolId?: string;
  answers: Record<string, string>;
  awaiting?:
    | { kind: "question"; questionIds: string[] }
    | { kind: "interlude"; questionId: string }
    | { kind: "fallback"; questionId: string; choice: string }
    | { kind: "approval" };
  active?: ActivePlanPath;
}

export interface PlanningReply {
  text: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  stopReason: "end_turn" | "tool_use";
  exerciseId?: string;
}

export type PlanningOutcome =
  | { kind: "reply"; reply: PlanningReply }
  | { kind: "interlude"; questionId: string; events: ReplayEvent[] }
  | { kind: "run"; active: ActivePlanPath };

const BOOK_SUFFIX = " (Book Recommended)";

function questionTool(tools: ToolDefinition[] | undefined): string | undefined {
  return (tools ?? []).find((tool) => tool.name?.toLowerCase() === "askuserquestion")?.name;
}

const PLANNING_TOOL_PREFIX = "aifirst_plan_";

function newToolId(stepId: string, kind: "question" | "fallback" | "approval", id: string): string {
  return `${PLANNING_TOOL_PREFIX}${stepId.replace(/[^a-zA-Z0-9_.-]/g, "_")}_${kind}_${id}_${crypto.randomUUID()}`;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(BOOK_SUFFIX.toLowerCase(), "").replace(/[^a-z0-9]+/g, " ").trim();
}

function resultText(block: ContentBlock): string {
  if (typeof block.content === "string") {
    try {
      const parsed = JSON.parse(block.content) as { answers?: Record<string, unknown> };
      const answer = Object.values(parsed.answers ?? {}).find((value): value is string => typeof value === "string");
      if (answer) return answer;
    } catch {
      const captured = block.content.match(/="([^"]+)"/);
      return captured?.[1] ?? block.content;
    }
    return block.content;
  }
  if (Array.isArray(block.content)) {
    return (block.content as ContentBlock[]).map((item) => item.text ?? "").join("\n").trim();
  }
  return "";
}

function planningResultBlocks(messages: RequestMessage[] | undefined): ContentBlock[] {
  const message = [...(messages ?? [])].reverse().find((candidate) => candidate.role !== "system");
  if (!message || message.role !== "user" || !Array.isArray(message.content)) return [];
  return message.content.filter((block) =>
    block?.type === "tool_result" &&
    typeof block.tool_use_id === "string" &&
    block.tool_use_id.startsWith(PLANNING_TOOL_PREFIX));
}

function planningResultBlock(messages: RequestMessage[] | undefined, expectedToolId?: string): ContentBlock | undefined {
  return planningResultBlocks(messages)
    .filter((block) => expectedToolId === undefined || block.tool_use_id === expectedToolId)
    .at(-1);
}

export function carriesPlanningToolResult(messages: RequestMessage[] | undefined): boolean {
  return planningResultBlocks(messages).length > 0;
}

export function planningToolCancelled(messages: RequestMessage[] | undefined, expectedToolId?: string): boolean {
  const result = planningResultBlock(messages, expectedToolId);
  if (!result) return false;
  if (result.is_error === true) return true;
  const text = resultText(result).trim();
  if (!text || /^\(?no content\)?$/i.test(text)) return true;
  if (/tool use was rejected|user (?:declined|doesn't want|does not want) to (?:answer|proceed)/i.test(text)) {
    return true;
  }
  if (typeof result.content === "string") {
    try {
      const parsed = JSON.parse(result.content) as { answers?: Record<string, unknown> };
      if (parsed.answers && Object.keys(parsed.answers).length === 0) return true;
    } catch {
      // Plain-text answers are handled by planningToolResult.
    }
  }
  return false;
}

export function planningToolResult(messages: RequestMessage[] | undefined, expectedToolId?: string): string | Record<string, string> | undefined {
  const result = planningResultBlock(messages, expectedToolId);
  if (!result) return undefined;
  if (typeof result.content === "string") {
    try {
      const parsed = JSON.parse(result.content) as { answers?: Record<string, unknown> };
      const answers = Object.fromEntries(Object.entries(parsed.answers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const values = Object.values(answers);
      if (values.length === 1) return values[0];
      if (values.length > 1) return answers;
    } catch {
      // Fall through to the plain-text client representation.
    }
    const summarized = Object.fromEntries(
      [...result.content.matchAll(/[·•]\s*(.+?)\s*→\s*(.+?)(?=\n\s*[·•]|$)/gs)]
        .map((match) => [match[1].replace(/\s+/g, " ").trim(), match[2].replace(/\s+/g, " ").trim()]),
    );
    if (Object.keys(summarized).length > 1) return summarized;
    const assigned = Object.fromEntries(
      [...result.content.matchAll(/"([^"]+)"\s*=\s*"([^"]+)"/g)].map((match) => [match[1], match[2]]),
    );
    if (Object.keys(assigned).length > 1) return assigned;
  }
  return resultText(result);
}

function applies(question: PlanQuestion, answers: Record<string, string>): boolean {
  return Object.entries(question.when ?? {}).every(([id, option]) => answers[id] === option);
}

function selectedOption(question: PlanQuestion, answer: string): string | undefined {
  const wanted = normalized(answer);
  return question.options.find((option) => normalized(option.id) === wanted || normalized(option.label) === wanted)?.id;
}

function suppliedAnswers(rawAnswer: string | Record<string, string>, questions: PlanQuestion[]): Record<string, string> {
  if (typeof rawAnswer !== "string") return rawAnswer;
  try {
    const parsed = JSON.parse(rawAnswer) as { answers?: Record<string, unknown> } | Record<string, unknown>;
    const source = "answers" in parsed && parsed.answers && typeof parsed.answers === "object" ? parsed.answers : parsed;
    const answers = Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (Object.keys(answers).length > 0) return answers;
  } catch {
    // A normal typed answer is not JSON.
  }
  return { [questions[0].question]: rawAnswer };
}

function paths(step: ReplayStep): ActivePlanPath[] {
  const workflow = step.replay?.workflow;
  if (!workflow || !step.replay) return [];
  const canonical: ActivePlanPath = {
    stepId: step.id,
    kind: "canonical",
    answers: workflow.canonicalAnswers,
    replay: step.replay,
  };
  const variants = (workflow.variants ?? []).map((variant): ActivePlanPath => ({
    stepId: step.id,
    kind: "authored",
    variantId: variant.id,
    answers: variant.answers,
    replay: replayForVariant(step.replay!, variant),
  }));
  return [canonical, ...variants];
}

function replayForVariant(parent: Replay, variant: PlanVariant): Replay {
  return {
    prompt: parent.prompt,
    operations: variant.operations,
    ...(variant.commentary ? { commentary: variant.commentary } : {}),
    ...(variant.events ? { events: variant.events } : {}),
    ...(parent.completionText ? { completionText: parent.completionText } : {}),
  };
}

function compatible(path: ActivePlanPath, answers: Record<string, string>): boolean {
  return Object.entries(answers).every(([question, answer]) => path.answers[question] === answer);
}

function exactPath(step: ReplayStep, answers: Record<string, string>): ActivePlanPath | undefined {
  const workflow = step.replay?.workflow;
  if (!workflow) return undefined;
  return paths(step).find((path) => workflow.questions.every((question) =>
    applies(question, path.answers) ? answers[question.id] === path.answers[question.id] : answers[question.id] === undefined));
}

function optionLabel(step: ReplayStep, question: PlanQuestion, optionId: string): string {
  const option = question.options.find((candidate) => candidate.id === optionId);
  const recommended = step.replay?.workflow?.canonicalAnswers[question.id] === optionId;
  return `${option?.label ?? optionId}${recommended ? BOOK_SUFFIX : ""}`;
}

function askQuestions(
  step: ReplayStep,
  state: PlanningSession,
  tools: ToolDefinition[] | undefined,
  questions: PlanQuestion[],
  reuseToolId?: string,
): PlanningOutcome {
  state.awaiting = { kind: "question", questionIds: questions.map((question) => question.id) };
  const tool = questionTool(tools);
  const nativeQuestions = questions.map((question) => ({
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({
      label: optionLabel(step, question, option.id),
      description: option.description,
    })),
    multiSelect: false,
  }));
  const text = "";
  if (!tool) {
    delete state.expectedToolId;
    return {
      kind: "reply",
      reply: {
        text: `${questions.map((question) => {
          const options = nativeQuestions.find((candidate) => candidate.question === question.question)!.options;
          return `${question.question}\n\n${options.map((option) => `- ${option.label}: ${option.description}`).join("\n")}`;
        }).join("\n\n")}\n\nReply with one option per question.`,
        stopReason: "end_turn",
        exerciseId: step.id,
      },
    };
  }
  state.expectedToolId = reuseToolId ?? newToolId(step.id, "question", questions.map((question) => question.id).join("+"));
  return {
    kind: "reply",
    reply: {
      text,
      toolUse: {
        id: state.expectedToolId,
        name: tool,
        input: {
          questions: nativeQuestions,
        },
      },
      stopReason: "tool_use",
      exerciseId: step.id,
    },
  };
}

function askFallback(
  step: ReplayStep,
  state: PlanningSession,
  tools: ToolDefinition[] | undefined,
  question: PlanQuestion,
  choice: string,
  reuseToolId?: string,
): PlanningOutcome {
  state.awaiting = { kind: "fallback", questionId: question.id, choice };
  const canonical = step.replay!.workflow!.canonicalAnswers[question.id];
  const tool = questionTool(tools);
  const text = [
    "## This choice needs an LLM",
    "",
    `You selected **${choice}**. That changes the design beyond the deterministic paths stored in local learning.`,
    "The built-in learner cannot invent and verify new code because no model is running.",
  ].join("\n");
  const options = [
    { label: "Use book-recommended answer", description: `Continue with ${optionLabel(step, question, canonical)}.` },
    { label: "Restart planning", description: "Clear all answers and start the questionnaire again." },
    { label: "Use an AI assistant", description: "Leave built-in learning and connect a supported AI tool from AI First Home." },
  ];
  if (!tool) {
    delete state.expectedToolId;
    return {
      kind: "reply",
      reply: { text: `${text}\n\n${options.map((option) => `- ${option.label}: ${option.description}`).join("\n")}`, stopReason: "end_turn", exerciseId: step.id },
    };
  }
  state.expectedToolId = reuseToolId ?? newToolId(step.id, "fallback", question.id);
  return {
    kind: "reply",
    reply: {
      text,
      toolUse: {
        id: state.expectedToolId,
        name: tool,
        input: {
          questions: [{ question: "How would you like to continue?", header: "Next step", options, multiSelect: false }],
        },
      },
      stopReason: "tool_use",
      exerciseId: step.id,
    },
  };
}

function askApproval(
  step: ReplayStep,
  state: PlanningSession,
  tools: ToolDefinition[] | undefined,
  active: ActivePlanPath,
  reuseToolId?: string,
): PlanningOutcome {
  state.awaiting = { kind: "approval" };
  const workflow = step.replay!.workflow!;
  const variant = active.kind === "authored" ? workflow.variants?.find((candidate) => candidate.id === active.variantId) : undefined;
  const plan = variant?.plan ?? workflow.canonicalPlan;
  const answers = workflow.questions
    .filter((question) => applies(question, active.answers))
    .map((question) => `- **${question.header}:** ${optionLabel(step, question, active.answers[question.id])}`)
    .join("\n");
  const text = [
    "## Proposed plan",
    "",
    "### Selected design",
    "",
    answers,
    "",
    plan,
    "",
    "No files have been changed yet.",
  ].join("\n");
  const tool = questionTool(tools);
  const options = [
    { label: "Approve and build", description: "Run the trusted operations for this plan." },
    { label: "Restart questions", description: "Clear the selections and plan again." },
    { label: "Cancel", description: "Stop without changing files or progress." },
  ];
  if (!tool) {
    delete state.expectedToolId;
    return { kind: "reply", reply: { text: `${text}\n\n${options.map((option) => `- ${option.label}`).join("\n")}`, stopReason: "end_turn", exerciseId: step.id } };
  }
  state.expectedToolId = reuseToolId ?? newToolId(step.id, "approval", "plan");
  return {
    kind: "reply",
    reply: {
      text,
      toolUse: {
        id: state.expectedToolId,
        name: tool,
        input: {
          questions: [{ question: "Approve this plan?", header: "Plan", options, multiSelect: false }],
        },
      },
      stopReason: "tool_use",
      exerciseId: step.id,
    },
  };
}

function advance(step: ReplayStep, state: PlanningSession, tools: ToolDefinition[] | undefined): PlanningOutcome {
  const workflow = step.replay!.workflow!;
  const next = workflow.questions.find((question) => applies(question, state.answers) && state.answers[question.id] === undefined);
  if (next) {
    const group = next.group;
    const start = workflow.questions.indexOf(next);
    const questions = group
      ? workflow.questions.slice(start).filter((question) => question.group === group && applies(question, state.answers) && state.answers[question.id] === undefined)
      : [next];
    return askQuestions(step, state, tools, questions);
  }
  const active = exactPath(step, state.answers);
  if (!active) {
    const last = [...workflow.questions].reverse().find((question) => state.answers[question.id] !== undefined)!;
    return askFallback(step, state, tools, last, state.answers[last.id]);
  }
  return askApproval(step, state, tools, active);
}

export function beginPlanning(step: ReplayStep, state: PlanningSession, tools: ToolDefinition[] | undefined): PlanningOutcome {
  state.stepId = step.id;
  delete state.expectedToolId;
  state.answers = {};
  state.awaiting = undefined;
  state.active = undefined;
  return advance(step, state, tools);
}

export function continuePlanning(
  step: ReplayStep,
  state: PlanningSession,
  tools: ToolDefinition[] | undefined,
  rawAnswer: string | Record<string, string>,
): PlanningOutcome {
  const awaiting = state.awaiting;
  const workflow = step.replay?.workflow;
  if (!awaiting || !workflow) return beginPlanning(step, state, tools);
  delete state.expectedToolId;

  if (awaiting.kind === "question") {
    const questions = awaiting.questionIds.map((id) => workflow.questions.find((candidate) => candidate.id === id)!);
    const supplied = suppliedAnswers(rawAnswer, questions);
    const candidateAnswers = { ...state.answers };
    const answeredQuestionIds: string[] = [];
    for (const question of questions) {
      const answer = supplied[question.question] ?? supplied[question.header] ?? supplied[question.id];
      if (answer === undefined) continue;
      const option = selectedOption(question, answer);
      if (!option) return askFallback(step, state, tools, question, answer || "Other");
      candidateAnswers[question.id] = option;
      answeredQuestionIds.push(question.id);
      if (!paths(step).some((path) => compatible(path, candidateAnswers))) {
        return askFallback(step, state, tools, question, optionLabel(step, question, option));
      }
    }
    state.answers = candidateAnswers;
    state.awaiting = undefined;
    const interlude = workflow.interludes?.find((candidate) => answeredQuestionIds.includes(candidate.afterQuestion));
    if (interlude) {
      state.awaiting = { kind: "interlude", questionId: interlude.afterQuestion };
      return { kind: "interlude", questionId: interlude.afterQuestion, events: interlude.events };
    }
    return advance(step, state, tools);
  }

  if (awaiting.kind === "interlude") {
    return { kind: "interlude", questionId: awaiting.questionId, events: workflow.interludes?.find((candidate) => candidate.afterQuestion === awaiting.questionId)?.events ?? [] };
  }

  if (awaiting.kind === "fallback") {
    const answer = normalized(typeof rawAnswer === "string" ? rawAnswer : Object.values(rawAnswer)[0] ?? "");
    if (["yes", "book", "recommended", normalized("Use book-recommended answer")].includes(answer)) {
      state.answers[awaiting.questionId] = workflow.canonicalAnswers[awaiting.questionId];
      state.awaiting = undefined;
      return advance(step, state, tools);
    }
    if (["restart", normalized("Restart planning")].includes(answer)) return beginPlanning(step, state, tools);
    if (!["exit", "cancel", normalized("Exit local learning"), normalized("Use an AI assistant")].includes(answer)) {
      const question = workflow.questions.find((candidate) => candidate.id === awaiting.questionId)!;
      return askFallback(step, state, tools, question, awaiting.choice);
    }
    state.stepId = undefined;
    state.replayMode = undefined;
    state.answers = {};
    state.awaiting = undefined;
    return {
      kind: "reply",
      reply: {
        text: "Planning ended without changing files. Open AI First Home to connect an AI assistant, then repeat the exercise prompt to build an adaptive version.",
        stopReason: "end_turn",
        exerciseId: step.id,
      },
    };
  }

  const answer = normalized(typeof rawAnswer === "string" ? rawAnswer : Object.values(rawAnswer)[0] ?? "");
  if (["yes", "approve", "approved", normalized("Approve and build")].includes(answer)) {
    const active = exactPath(step, state.answers)!;
    state.active = active;
    state.awaiting = undefined;
    return { kind: "run", active };
  }
  if (["restart", normalized("Restart questions")].includes(answer)) return beginPlanning(step, state, tools);
  if (!["no", "cancel"].includes(answer)) {
    const active = exactPath(step, state.answers)!;
    return askApproval(step, state, tools, active);
  }
  state.stepId = undefined;
  state.replayMode = undefined;
  state.answers = {};
  state.awaiting = undefined;
  return {
    kind: "reply",
    reply: { text: "Planning cancelled. No files were changed and no progress was recorded.", stopReason: "end_turn", exerciseId: step.id },
  };
}

export function finishPlanningInterlude(
  step: ReplayStep,
  state: PlanningSession,
  tools: ToolDefinition[] | undefined,
  questionId: string,
): PlanningOutcome {
  if (state.awaiting?.kind !== "interlude" || state.awaiting.questionId !== questionId) return beginPlanning(step, state, tools);
  state.awaiting = undefined;
  return advance(step, state, tools);
}

export function repeatPlanning(
  step: ReplayStep,
  state: PlanningSession,
  tools: ToolDefinition[] | undefined,
): PlanningOutcome {
  const awaiting = state.awaiting;
  const toolUseId = state.expectedToolId;
  const workflow = step.replay?.workflow;
  if (!awaiting || !workflow) return beginPlanning(step, state, tools);
  if (awaiting.kind === "question") {
    const questions = awaiting.questionIds.map((id) => workflow.questions.find((question) => question.id === id)!);
    return askQuestions(step, state, tools, questions, toolUseId);
  }
  if (awaiting.kind === "fallback") {
    const question = workflow.questions.find((candidate) => candidate.id === awaiting.questionId)!;
    return askFallback(step, state, tools, question, awaiting.choice, toolUseId);
  }
  if (awaiting.kind === "approval") {
    const active = exactPath(step, state.answers);
    return active ? askApproval(step, state, tools, active, toolUseId) : beginPlanning(step, state, tools);
  }
  return { kind: "interlude", questionId: awaiting.questionId, events: workflow.interludes?.find((candidate) => candidate.afterQuestion === awaiting.questionId)?.events ?? [] };
}

export function clearActivePlanning(state: PlanningSession): void {
  state.stepId = undefined;
  state.replayMode = undefined;
  delete state.expectedToolId;
  state.answers = {};
  state.awaiting = undefined;
  state.active = undefined;
}
