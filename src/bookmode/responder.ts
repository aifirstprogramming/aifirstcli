/**
 * What book mode answers, with no model involved.
 *
 * Everything a reader sees for a book exercise was computed and committed at
 * authoring time: the prompt, the byte-exact code, the explanation, the sample
 * input, the command that runs it. So a prompt printed in the book needs no
 * reasoning at request time — the reasoning already happened, and this turns the
 * reader's typed prompt back into that stored answer.
 *
 * Deliberately pure and HTTP-free: the whole behaviour of book mode is decided
 * here and tested without a socket. `serve.ts` only encodes what this returns.
 */

import { findMatchingStep } from "@aifirst/content";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chatCommandError, isLocalCommand, localHelp, parseChatCommand } from "./commands";
import type { ContentSource, SourceReply, SourceState } from "./contentSource";
import { renderBookEnvelope, renderStep } from "./render";
import type { Content } from "../content/types";
import { writeScaffold } from "../content/scaffold";
import type { ProgressLog } from "../log/progress";
import { markIfNew } from "../log/progress";
import { executeReplay } from "../replay/executor";
import { resolveReplay, type ReplayCandidate } from "../replay/resolver";
import type { ReplayEvent, ReplayOperation, ReplayStep } from "../content/types";
import { clearPendingReplay, confirmationAnswer, readPendingReplay, replaySelection, savePendingReplay } from "../replay/pending";
import {
  beginPlanning,
  carriesPlanningToolResult,
  clearActivePlanning,
  continuePlanning,
  finishPlanningInterlude,
  planningToolCancelled,
  planningToolResult,
  repeatPlanning,
  type ActivePlanPath,
  type PlanningSession,
} from "./planning";
import type { Replay } from "../content/types";
import type { DependencyReport } from "../dependencies";
import { checkDependencies, dependencyNames, resolvePythonRuntime, withPythonRuntime } from "../dependencies";
import type { NativeLearnAction } from "../learn/actions";

/** The subset of an Anthropic request this needs. Everything else is ignored. */
export interface MessagesRequest {
  model?: string;
  stream?: boolean;
  messages?: RequestMessage[];
  tools?: ToolDefinition[];
}

export interface RequestMessage {
  role: string;
  content?: string | ContentBlock[];
}

export interface ContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name?: string;
  input_schema?: { properties?: Record<string, unknown>; required?: string[] };
}

export interface Reply {
  text: string;
  /** Built-in learner presentation that preserves text/status boundaries. */
  nativeBlocks?: Array<{ kind: "text" | "status"; text: string }>;
  /** Present when the reply asks the client to run the exercise. */
  toolUse?: { id?: string; name: string; input: Record<string, unknown>; nativeAction?: NativeLearnAction };
  stopReason: "end_turn" | "tool_use";
  /** Which exercise this answered, when it answered one. Used only for logging. */
  exerciseId?: string;
  /** Built-in learner only: build finished, but completion waits for Run/Finish. */
  nativeReady?: boolean;
}

/**
 * The tool the client offers for running a shell command.
 *
 * Discovered from the request rather than hard-coded. Claude Code sent 24 tools in
 * the spike and calls this one `Bash` today, but a name we hard-coded would be a
 * silent breakage the first time it changed. A tool taking a `command` string is
 * the thing we actually need, so that is what we look for.
 */
export function shellTool(tools: ToolDefinition[] | undefined): string | undefined {
  for (const tool of tools ?? []) {
    if (!tool?.name) continue;
    const props = tool.input_schema?.properties ?? {};
    const command = props.command as { type?: string } | undefined;
    if (command && (command.type === undefined || command.type === "string")) return tool.name;
  }
  return undefined;
}

function writeTool(tools: ToolDefinition[] | undefined): string | undefined {
  return (tools ?? []).find((tool) => tool.name?.toLowerCase() === "write")?.name;
}

function editTool(tools: ToolDefinition[] | undefined): string | undefined {
  return (tools ?? []).find((tool) => tool.name?.toLowerCase() === "edit")?.name;
}

function readTool(tools: ToolDefinition[] | undefined): string | undefined {
  return (tools ?? []).find((tool) => tool.name?.toLowerCase() === "read")?.name;
}

function questionTool(tools: ToolDefinition[] | undefined): string | undefined {
  return (tools ?? []).find((tool) => tool.name?.toLowerCase() === "askuserquestion")?.name;
}

const CONFIRMATION_TOOL_PREFIX = "aifirst_confirm_";

function newConfirmationToolId(): string {
  return `${CONFIRMATION_TOOL_PREFIX}${crypto.randomUUID()}`;
}

function confirmationQuestion(
  step: ReplayStep,
  tools: ToolDefinition[] | undefined,
  toolUseId = newConfirmationToolId(),
): Reply["toolUse"] | undefined {
  const name = questionTool(tools);
  if (!name) return undefined;
  const prompt = step.replay?.prompt ?? step.prompt;
  return {
    id: toolUseId,
    name,
    input: {
      questions: [{
        question: `Did you mean this AI First exercise?\n\n${prompt}`,
        header: "AI First",
        options: [
          { label: "Run this replay", description: `Run ${step.id} using its captured AI First replay.` },
          { label: "Cancel", description: "Do not run an exercise." },
        ],
        multiSelect: false,
      }],
    },
  };
}

interface ConfirmationState {
  stepId?: string;
  stepIds?: string[];
  confirmationToolId?: string;
  ambiguityToolId?: string;
}

export interface DependencySession {
  stepId?: string;
  confirmationToolId?: string;
  installToolId?: string;
}

export type DependencyCheck = (step: ReplayStep) => DependencyReport;

const DEPENDENCY_CONFIRM_PREFIX = "aifirst_dependency_confirm_";
const DEPENDENCY_INSTALL_PREFIX = "aifirst_dependency_install_";

function clearDependencySession(state: DependencySession | undefined): void {
  if (!state) return;
  delete state.stepId;
  delete state.confirmationToolId;
  delete state.installToolId;
}

const AMBIGUITY_TOOL_PREFIX = "aifirst_choose_replay";

function newAmbiguityToolId(): string {
  // Full Claude histories can retain older picker results, so each transaction needs its own id.
  return `${AMBIGUITY_TOOL_PREFIX}_${crypto.randomUUID()}`;
}

function confirmationIds(state: ConfirmationState | undefined): string[] {
  return state?.stepIds ?? (state?.stepId ? [state.stepId] : []);
}

function pendingConfirmationIds(state: ConfirmationState | undefined): string[] {
  return state ? confirmationIds(state) : readPendingReplay()?.stepIds ?? [];
}

function setConfirmation(state: ConfirmationState | undefined, stepIds: string[]): void {
  if (!state) {
    savePendingReplay(stepIds);
    return;
  }
  const previous = confirmationIds(state);
  const sameCandidates = previous.length === stepIds.length &&
    previous.every((id, index) => id === stepIds[index]);
  delete state.stepId;
  delete state.stepIds;
  if (stepIds.length === 1) {
    delete state.ambiguityToolId;
    if (!sameCandidates || !state.confirmationToolId) state.confirmationToolId = newConfirmationToolId();
    state.stepId = stepIds[0];
  } else {
    delete state.confirmationToolId;
    if (!sameCandidates || !state.ambiguityToolId) state.ambiguityToolId = newAmbiguityToolId();
    state.stepIds = stepIds.slice(0, 3);
  }
}

function clearConfirmation(state: ConfirmationState | undefined): void {
  if (state) {
    delete state.stepId;
    delete state.stepIds;
    delete state.confirmationToolId;
    delete state.ambiguityToolId;
  }
  clearPendingReplay();
}

function candidateLabel(content: Content, step: ReplayStep): string {
  const title = content.examples.find((example) => example.id === step.exampleId)?.title ?? step.id;
  return `${title} (${step.id})`;
}

function ambiguityText(content: Content, candidates: ReplayCandidate[]): string {
  const choices = candidates.map(({ step }, index) =>
    `${index + 1}. **${candidateLabel(content, step)}** — ${step.replay?.prompt ?? step.prompt}`);
  return [
    "Several AI First exercises may match this prompt.",
    "",
    ...choices,
    `${choices.length + 1}. **None of these** — Do not run an exercise.`,
    "",
    "Reply with an exercise number or id. Choosing None of these makes no changes.",
  ].join("\n");
}

function ambiguityQuestion(
  content: Content,
  candidates: ReplayCandidate[],
  tools: ToolDefinition[] | undefined,
  toolUseId = newAmbiguityToolId(),
): Reply["toolUse"] | undefined {
  const name = questionTool(tools);
  if (!name) return undefined;
  return {
    id: toolUseId,
    name,
    input: {
      questions: [{
        question: "Which AI First exercise did you mean?",
        header: "Exercise",
        options: [
          ...candidates.map(({ step }) => ({
            label: candidateLabel(content, step),
            description: step.replay?.prompt ?? step.prompt,
          })),
          { label: "None of these", description: "Do not run or record an exercise." },
        ],
        multiSelect: false,
      }],
    },
  };
}

function ambiguityReply(
  content: Content,
  candidates: ReplayCandidate[],
  tools: ToolDefinition[] | undefined,
  toolUseId?: string,
): Reply {
  const question = ambiguityQuestion(content, candidates, tools, toolUseId);
  return {
    text: question
      ? "Several AI First exercises may match this prompt. Choose one, or choose None of these to make no changes."
      : ambiguityText(content, candidates),
    ...(question ? { toolUse: question } : {}),
    stopReason: question ? "tool_use" : "end_turn",
  };
}

function replayToolId(stepId: string, operationIndex: number): string {
  return `aifirst_replay_${stepId.replace(/[^a-zA-Z0-9_.-]/g, "_")}_${operationIndex}`;
}

function standaloneReplayToolId(stepId: string, operationIndex: number): string {
  return `aifirst_replay_standalone_${stepId.replace(/[^a-zA-Z0-9_.-]/g, "_")}_${operationIndex}`;
}

function prePlanToolId(stepId: string, operationIndex: number): string {
  return `aifirst_preplan_${stepId.replace(/[^a-zA-Z0-9_.-]/g, "_")}_${operationIndex}`;
}

function interludeToolId(stepId: string, questionId: string, operationIndex: number): string {
  return `aifirst_interlude_${stepId.replace(/[^a-zA-Z0-9_.-]/g, "_")}_q_${questionId.replace(/[^a-zA-Z0-9_.-]/g, "_")}_i_${operationIndex}`;
}

interface ReplaySegment {
  text: string;
  blocks: Array<{ kind: "text" | "status"; text: string }>;
  operation: ReplayOperation;
}

function replaySegments(replay: Replay | undefined): ReplaySegment[] {
  if (!replay) return [];
  if (!replay.events) {
    return replay.operations.map((operation, index) => {
      const text = replay.commentary?.[index] ?? "";
      return { text, blocks: text ? [{ kind: "text" as const, text }] : [], operation };
    });
  }
  const segments: ReplaySegment[] = [];
  const blocks: ReplaySegment["blocks"] = [];
  for (const event of replay.events) {
    if (event.type === "operation") {
      segments.push({ text: blocks.map((block) => block.text).join("\n\n"), blocks: [...blocks], operation: event.operation });
      blocks.length = 0;
    } else {
      blocks.push({ kind: event.type === "status" ? "status" : "text", text: event.text });
    }
  }
  return segments;
}

function eventSegments(events: Replay["events"]): ReplaySegment[] {
  const segments: ReplaySegment[] = [];
  const blocks: ReplaySegment["blocks"] = [];
  for (const event of events ?? []) {
    if (event.type === "operation") {
      segments.push({ text: blocks.map((block) => block.text).join("\n\n"), blocks: [...blocks], operation: event.operation });
      blocks.length = 0;
    } else {
      blocks.push({ kind: event.type === "status" ? "status" : "text", text: event.text });
    }
  }
  return segments;
}

function prePlanSegments(replay: Replay | undefined): ReplaySegment[] {
  return eventSegments(replay?.prePlanEvents);
}

function eventTrailingBlocks(events: Replay["events"]): ReplaySegment["blocks"] {
  let lastOperation = -1;
  (events ?? []).forEach((event, index) => {
    if (event.type === "operation") lastOperation = index;
  });
  return (events ?? []).slice(lastOperation + 1).flatMap((event) =>
    event.type === "operation" ? [] : [{ kind: event.type === "status" ? "status" as const : "text" as const, text: event.text }]);
}

function workflowInterludeEvents(step: ReplayStep, questionId: string): ReplayEvent[] {
  return step.replay?.workflow?.interludes?.find((interlude) => interlude.afterQuestion === questionId)?.events ?? [];
}

function replayTrailingText(replay: Replay | undefined): string {
  if (!replay?.events) return replay?.completionText ?? "";
  let lastOperation = -1;
  replay.events.forEach((event, index) => {
    if (event.type === "operation") lastOperation = index;
  });
  const trailing = replay.events.slice(lastOperation + 1)
    .filter((event) => event.type !== "operation")
    .map((event) => event.text);
  if (replay.completionText) trailing.push(replay.completionText);
  return trailing.join("\n\n");
}

function latestToolResult(messages: RequestMessage[] | undefined): ContentBlock | undefined {
  // Only the final message can acknowledge the tool request from the prior
  // turn. Searching older user messages replays the same completion forever
  // when Claude sends the full conversation on every request.
  const message = [...(messages ?? [])].reverse().find((candidate) => candidate.role !== "system");
  if (!message || message.role !== "user" || !Array.isArray(message.content)) return undefined;
  const blocks = message.content.filter(Boolean);
  if (blocks.length === 0 || blocks.some((block) => block?.type !== "tool_result")) return undefined;
  return blocks.find((block): block is ContentBlock => block?.type === "tool_result");
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function replayToolUse(
  step: ReplayStep,
  operationIndex: number,
  tools: ToolDefinition[] | undefined,
  replay: Replay | undefined = step.replay,
  phase: "replay" | "preplan" = "replay",
  standalone = false,
): Reply["toolUse"] | undefined {
  const operation = (phase === "preplan" ? prePlanSegments(replay) : replaySegments(replay))[operationIndex]?.operation;
  if (!operation) return undefined;
  const id = phase === "preplan"
    ? prePlanToolId(step.id, operationIndex)
    : standalone
      ? standaloneReplayToolId(step.id, operationIndex)
      : replayToolId(step.id, operationIndex);
  return operationToolUse(id, operation, tools);
}

function operationToolUse(
  id: string,
  operation: ReplayOperation,
  tools: ToolDefinition[] | undefined,
): Reply["toolUse"] | undefined {
  if (operation.type === "write") {
    const name = writeTool(tools);
    const path = resolve(process.cwd(), operation.path);
    if (name) {
      return {
        id,
        name,
        input: { file_path: path, content: operation.content },
        nativeAction: { kind: "replay-operation", operation },
      };
    }
    const shell = shellTool(tools);
    if (!shell) return undefined;
    return {
      id,
      name: shell,
      input: {
        command: `mkdir -p ${shellQuote(dirname(path))} && printf %s ${shellQuote(operation.content)} > ${shellQuote(path)}`,
        description: `Write ${operation.path}`,
      },
      nativeAction: { kind: "replay-operation", operation },
    };
  }
  if (operation.type === "edit") {
    const name = editTool(tools);
    if (!name) return undefined;
    return {
      id,
      name,
      input: {
        file_path: resolve(process.cwd(), operation.path),
        old_string: operation.oldText,
        new_string: operation.newText,
        ...(operation.replaceAll === undefined ? {} : { replace_all: operation.replaceAll }),
      },
      nativeAction: { kind: "replay-operation", operation },
    };
  }
  if (operation.type === "read") {
    const name = readTool(tools);
    if (!name) return undefined;
    return {
      id,
      name,
      input: { file_path: resolve(process.cwd(), operation.path) },
      nativeAction: { kind: "replay-operation", operation },
    };
  }
  const name = shellTool(tools);
  if (!name) return undefined;
  const runtime = resolvePythonRuntime();
  const operationCommand = runtime ? withPythonRuntime(operation.command, runtime) : operation.command;
  const command = operationCommand.map(shellQuote).join(" ");
  const cwd = operation.cwd && operation.cwd !== "." ? `cd -- ${shellQuote(operation.cwd)} && ` : "";
  const environment = Object.entries(operation.env ?? {}).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  return {
    id,
    name,
    input: {
      command: `${cwd}${environment ? `${environment} ` : ""}${command}`,
      ...(operation.stdin === undefined ? {} : { stdin: operation.stdin }),
    },
    nativeAction: { kind: "replay-operation", operation },
  };
}

function replayToolResult(messages: RequestMessage[] | undefined): { stepId: string; operationIndex: number; standalone: boolean; failed: boolean; detail: string } | undefined {
  const result = latestToolResult(messages);
  if (!result || typeof result.tool_use_id !== "string") return undefined;
  const standaloneMatch = result.tool_use_id.match(/^aifirst_replay_standalone_(.+)_([0-9]+)$/);
  const match = standaloneMatch ?? result.tool_use_id.match(/^aifirst_replay_(.+)_([0-9]+)$/);
  if (!match) return undefined;
  const raw = result.content;
  const detail = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? (raw as ContentBlock[]).map((block) => block.text ?? "").join("\n")
      : "";
  return {
    stepId: match[1],
    operationIndex: Number(match[2]),
    standalone: standaloneMatch !== null,
    failed: result.is_error === true,
    detail: detail.trim(),
  };
}

function prePlanToolResult(messages: RequestMessage[] | undefined): { stepId: string; operationIndex: number; failed: boolean; detail: string } | undefined {
  const result = latestToolResult(messages);
  if (!result || typeof result.tool_use_id !== "string") return undefined;
  const match = result.tool_use_id.match(/^aifirst_preplan_(.+)_([0-9]+)$/);
  if (!match) return undefined;
  const raw = result.content;
  const detail = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? (raw as ContentBlock[]).map((block) => block.text ?? "").join("\n")
      : "";
  return { stepId: match[1], operationIndex: Number(match[2]), failed: result.is_error === true, detail: detail.trim() };
}

function interludeToolResult(messages: RequestMessage[] | undefined): { stepId: string; questionId: string; operationIndex: number; failed: boolean; detail: string } | undefined {
  const result = latestToolResult(messages);
  if (!result || typeof result.tool_use_id !== "string") return undefined;
  const match = result.tool_use_id.match(/^aifirst_interlude_(.+)_q_([a-zA-Z0-9_.-]+)_i_([0-9]+)$/);
  if (!match) return undefined;
  const raw = result.content;
  const detail = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? (raw as ContentBlock[]).map((block) => block.text ?? "").join("\n")
      : "";
  return {
    stepId: match[1],
    questionId: match[2],
    operationIndex: Number(match[3]),
    failed: result.is_error === true,
    detail: detail.trim(),
  };
}

function interactiveToolResults(messages: RequestMessage[] | undefined, prefix: string): ContentBlock[] {
  const message = [...(messages ?? [])].reverse().find((candidate) => candidate.role !== "system");
  return message?.role === "user" && Array.isArray(message.content)
    ? message.content.filter((block) =>
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block.tool_use_id.startsWith(prefix))
    : [];
}

function confirmationToolResult(
  messages: RequestMessage[] | undefined,
  expectedToolId?: string,
): { accepted: boolean; failed: boolean } | undefined {
  const results = interactiveToolResults(messages, CONFIRMATION_TOOL_PREFIX)
    .filter((block) => expectedToolId === undefined || block.tool_use_id === expectedToolId);
  const result = results.at(-1);
  if (!result) return undefined;
  const detail = typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? "");
  const normalized = detail.toLowerCase();
  return {
    accepted: normalized.includes("run this replay"),
    failed: result.is_error === true,
  };
}

function toolAnswer(block: ContentBlock): string {
  if (typeof block.content !== "string") return JSON.stringify(block.content ?? "");
  try {
    const parsed = JSON.parse(block.content) as { answers?: Record<string, unknown> };
    const answer = Object.values(parsed.answers ?? {}).find((value): value is string => typeof value === "string");
    return answer ?? block.content;
  } catch {
    return block.content;
  }
}

function dependencyQuestion(
  step: ReplayStep,
  report: DependencyReport,
  tools: ToolDefinition[] | undefined,
  state: DependencySession,
): Reply {
  const name = questionTool(tools);
  const packages = dependencyNames(report.missing);
  if (!name) {
    return {
      text: `${step.id} needs ${packages}. Install them with \`aifirst dependencies install ${step.id}\`, then repeat the exercise prompt. No files were changed.`,
      stopReason: "end_turn",
      exerciseId: step.id,
    };
  }

  if (state.stepId && state.stepId !== step.id) clearDependencySession(state);
  state.stepId = step.id;
  state.confirmationToolId ??= `${DEPENDENCY_CONFIRM_PREFIX}${crypto.randomUUID()}`;
  return {
    text: `${step.id} needs ${packages} before the exercise can start.`,
    toolUse: {
      id: state.confirmationToolId,
      name,
      input: {
        questions: [{
          question: `Install ${packages} now?${report.installTarget ? `\n\nInstall target: ${report.installTarget}` : ""}`,
          header: "Dependencies",
          options: [
            { label: "Install dependencies", description: "Install the missing packages and continue this exercise." },
            { label: "Cancel exercise", description: "Make no changes and stop this exercise." },
          ],
          multiSelect: false,
        }],
      },
    },
    stopReason: "tool_use",
    exerciseId: step.id,
  };
}

function dependencyConfirmationResult(
  messages: RequestMessage[] | undefined,
  expectedToolId: string | undefined,
): { accepted: boolean; failed: boolean } | undefined {
  if (!expectedToolId) return undefined;
  const result = interactiveToolResults(messages, DEPENDENCY_CONFIRM_PREFIX)
    .filter((block) => block.tool_use_id === expectedToolId)
    .at(-1);
  if (!result) return undefined;
  return {
    accepted: toolAnswer(result).toLowerCase().includes("install dependencies"),
    failed: result.is_error === true,
  };
}

function dependencyInstallResult(
  messages: RequestMessage[] | undefined,
  expectedToolId: string | undefined,
): { failed: boolean; detail: string } | undefined {
  const result = latestToolResult(messages);
  if (!result || !expectedToolId || result.tool_use_id !== expectedToolId) return undefined;
  const raw = result.content;
  const detail = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? (raw as ContentBlock[]).map((block) => block.text ?? "").join("\n")
      : "";
  return { failed: result.is_error === true, detail: detail.trim() };
}

function ambiguityToolResult(
  messages: RequestMessage[] | undefined,
  expectedToolId?: string,
): { answer: string; failed: boolean } | undefined {
  const message = [...(messages ?? [])].reverse().find((candidate) => candidate.role !== "system");
  const results = message?.role === "user" && Array.isArray(message.content)
    ? message.content.filter((block) =>
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        (expectedToolId
          ? block.tool_use_id === expectedToolId
          : block.tool_use_id.startsWith(AMBIGUITY_TOOL_PREFIX)))
    : [];
  const result = results.at(-1);
  if (!result) return undefined;
  return { answer: toolAnswer(result), failed: result.is_error === true };
}

function replayResultMatches(
  step: ReplayStep,
  operationIndex: number,
  result: { failed: boolean; detail: string },
  replay: Replay | undefined = step.replay,
  relaxCommandOutput = false,
): boolean {
  const operation = replaySegments(replay)[operationIndex]?.operation;
  return operation ? operationResultMatches(operation, result, relaxCommandOutput) : false;
}

function operationResultMatches(
  operation: ReplayOperation,
  result: { failed: boolean; detail: string },
  relaxCommandOutput = false,
): boolean {
  if (operation.type !== "command") return !result.failed;
  // Claude marks every non-zero Bash result as an error, including failures the
  // captured session expected and then repaired on the next replay turn.
  const expectedExit = operation.expectedExitCode ?? 0;
  if (result.failed && expectedExit === 0) return false;
  const reportedExit = result.detail.match(/\bexit code\s+(\d+)\b/i)?.[1];
  if (reportedExit !== undefined && Number(reportedExit) !== expectedExit) return false;
  if (relaxCommandOutput) return true;
  if (operation.expectedStdout !== undefined && !result.detail.includes(operation.expectedStdout.trim())) return false;
  if (operation.expectedStderr !== undefined && !result.detail.includes(operation.expectedStderr.trim())) return false;
  return true;
}

function replayMismatch(label: string, turn: number, detail: string): string {
  const summary = detail.trim().slice(0, 1_200);
  return [
    `AI First replay stopped: the ${label}result for turn ${turn} did not match the captured result.`,
    ...(summary ? ["", "```text", summary, "```"] : []),
  ].join("\n");
}

function replayPrelude(step: ReplayStep, content: Content): string {
  const example = content.examples.find((candidate) => candidate.id === step.exampleId);
  return example ? `${renderBookEnvelope(example, step, "start")}\n\n---\n\n## AI First Replay` : "## AI First Replay";
}

function replayTurn(step: ReplayStep, operationIndex: number, replay: Replay | undefined = step.replay): string {
  const commentary = replaySegments(replay)[operationIndex]?.text;
  if (replay?.events) return commentary ?? "";
  return commentary
    ? `### Turn ${operationIndex + 1}\n\n${commentary}`
    : `### Turn ${operationIndex + 1}`;
}

function nativeReplayReply(
  step: ReplayStep,
  content: Content,
  tools: ToolDefinition[] | undefined,
  operationIndex: number,
  replay: Replay | undefined = step.replay,
  standalone = false,
): Reply {
  const toolUse = replayToolUse(step, operationIndex, tools, replay, "replay", standalone);
  if (!toolUse) {
    return {
      text: `${replayPrelude(step, content)}\n\nReplay cannot continue because the client did not expose the required tool.`,
      stopReason: "end_turn",
      exerciseId: step.id,
    };
  }
  if (replay?.events) {
    return { text: replayTurn(step, operationIndex, replay), nativeBlocks: replaySegments(replay)[operationIndex]?.blocks, toolUse, stopReason: "tool_use", exerciseId: step.id };
  }
  const header = operationIndex === 0 ? replayPrelude(step, content) : "## AI First Replay (continued)";
  return { text: `${header}\n\n${replayTurn(step, operationIndex, replay)}`, toolUse, stopReason: "tool_use", exerciseId: step.id };
}

function withLeadingText(reply: Reply, leading: string): Reply {
  return leading ? { ...reply, text: reply.text ? `${leading}\n\n${reply.text}` : leading } : reply;
}

function withLeadingBlocks(reply: Reply, blocks: ReplaySegment["blocks"]): Reply {
  if (blocks.length === 0) return reply;
  const leading = blocks.map((block) => block.text).join("\n\n");
  return {
    ...reply,
    text: reply.text ? `${leading}\n\n${reply.text}` : leading,
    nativeBlocks: [...blocks, ...(reply.nativeBlocks ?? (reply.text ? [{ kind: "text" as const, text: reply.text }] : []))],
  };
}

function prePlanReply(
  step: ReplayStep,
  content: Content,
  tools: ToolDefinition[] | undefined,
  planning: PlanningSession,
  operationIndex: number,
): Reply {
  const segment = prePlanSegments(step.replay)[operationIndex];
  if (!segment) {
    const outcome = beginPlanning(step, planning, tools);
    return withLeadingBlocks(planningOutcomeReply(step, content, tools, planning, outcome), eventTrailingBlocks(step.replay?.prePlanEvents));
  }
  const toolUse = replayToolUse(step, operationIndex, tools, step.replay, "preplan");
  if (!toolUse) {
    return {
      text: `${segment.text}\n\nReplay cannot continue because the client did not expose the required tool.`.trim(),
      stopReason: "end_turn",
      exerciseId: step.id,
    };
  }
  return { text: segment.text, nativeBlocks: segment.blocks, toolUse, stopReason: "tool_use", exerciseId: step.id };
}

function planningOutcomeReply(
  step: ReplayStep,
  content: Content,
  tools: ToolDefinition[] | undefined,
  planning: PlanningSession,
  outcome: ReturnType<typeof continuePlanning>,
): Reply {
  if (outcome.kind === "reply") return outcome.reply;
  if (outcome.kind === "run") {
    writeScaffold(process.cwd(), step, content, { binaryOnly: true });
    return nativeReplayReply(
      step,
      content,
      tools,
      0,
      outcome.active.replay,
      planning.replayMode === "standalone",
    );
  }
  return planningInterludeReply(step, content, tools, planning, outcome.questionId, 0);
}

function planningInterludeReply(
  step: ReplayStep,
  content: Content,
  tools: ToolDefinition[] | undefined,
  planning: PlanningSession,
  questionId: string,
  operationIndex: number,
): Reply {
  const events = workflowInterludeEvents(step, questionId);
  const segment = eventSegments(events)[operationIndex];
  if (!segment) {
    const outcome = finishPlanningInterlude(step, planning, tools, questionId);
    return withLeadingBlocks(planningOutcomeReply(step, content, tools, planning, outcome), eventTrailingBlocks(events));
  }
  const toolUse = operationToolUse(interludeToolId(step.id, questionId, operationIndex), segment.operation, tools);
  if (!toolUse) {
    return {
      text: `${segment.text}\n\nReplay cannot continue because the client did not expose the required tool.`.trim(),
      stopReason: "end_turn",
      exerciseId: step.id,
    };
  }
  return { text: segment.text, nativeBlocks: segment.blocks, toolUse, stopReason: "tool_use", exerciseId: step.id };
}

type ReplayMode = "captured" | "standalone";

function scaffoldContent(
  file: NonNullable<ReplayStep["scaffold"]>["files"][number],
  content: Content,
): string | undefined {
  if (file.content !== undefined) return file.content;
  if (!file.fromExercise) return undefined;
  return content.steps.find((candidate) => candidate.id === file.fromExercise)?.response;
}

function workspaceMatchesInitialState(step: ReplayStep, content: Content): boolean {
  const initialId = step.replay?.initialState?.fromExercise;
  if (!initialId) return true;
  const initial = content.steps.find((candidate) => candidate.id === initialId);
  const files = initial?.scaffold?.files ?? [];
  if (files.length === 0) return false;
  return files.every((rawFile) => {
    const file = rawFile as typeof rawFile & { contentBase64?: string };
    if (file.contentBase64 !== undefined) return true;
    const expected = scaffoldContent(file, content);
    if (expected === undefined) return false;
    try {
      const actual = readFileSync(resolve(process.cwd(), file.path), "utf8");
      return actual === expected || (!expected.endsWith("\n") && actual === `${expected}\n`);
    } catch {
      return false;
    }
  });
}

function standaloneReplay(replay: Replay): Replay {
  const { prePlanEvents: _prePlanEvents, events: _events, workflow, ...fallback } = replay;
  if (!workflow) return fallback;
  const { interludes: _interludes, ...standaloneWorkflow } = workflow;
  return { ...fallback, workflow: standaloneWorkflow };
}

function replayStepForMode(step: ReplayStep, mode: ReplayMode): ReplayStep {
  if (mode === "captured" || !step.replay) return step;
  return { ...step, replay: standaloneReplay(step.replay) };
}

function planningStep(step: ReplayStep | undefined, planning: PlanningSession | undefined): ReplayStep | undefined {
  if (!step) return undefined;
  return replayStepForMode(step, planning?.replayMode ?? "captured");
}

function beginSelectedReplay(
  step: ReplayStep | undefined,
  content: Content,
  tools: ToolDefinition[] | undefined,
  planning: PlanningSession | undefined,
): Reply {
  if (!step?.replay) {
    return { text: "That replay is no longer available. Please repeat the exercise prompt.", stopReason: "end_turn" };
  }
  const replayMode = workspaceMatchesInitialState(step, content) ? "captured" : "standalone";
  const selectedStep = replayStepForMode(step, replayMode);
  const notice = replayMode === "standalone" && step.replay.initialState
    ? `The captured ${step.replay.initialState.fromExercise} project is not present, so this exercise will use its self-contained build path. No files have been changed.`
    : "";
  if (selectedStep.replay!.workflow && planning) {
    planning.replayMode = replayMode;
    if (prePlanSegments(selectedStep.replay).length > 0) {
      return withLeadingText(prePlanReply(selectedStep, content, tools, planning, 0), notice);
    }
    const outcome = beginPlanning(selectedStep, planning, tools);
    return withLeadingText(
      withLeadingBlocks(
        planningOutcomeReply(selectedStep, content, tools, planning, outcome),
        eventTrailingBlocks(selectedStep.replay?.prePlanEvents),
      ),
      notice,
    );
  }
  writeScaffold(process.cwd(), selectedStep, content, { binaryOnly: true });
  return withLeadingText(
    nativeReplayReply(
      selectedStep,
      content,
      tools,
      0,
      selectedStep.replay,
      replayMode === "standalone",
    ),
    notice,
  );
}

function selectedReplayReply(
  step: ReplayStep | undefined,
  content: Content,
  tools: ToolDefinition[] | undefined,
  planning: PlanningSession | undefined,
  dependencies: DependencySession | undefined,
  dependencyCheck: DependencyCheck | undefined,
): Reply {
  if (!step?.replay) return beginSelectedReplay(step, content, tools, planning);
  if (!dependencies || !step.dependencies?.length) {
    return beginSelectedReplay(step, content, tools, planning);
  }

  const report = (dependencyCheck ?? ((candidate) => checkDependencies(candidate.dependencies)))(step);
  if (report.missing.length === 0) {
    clearDependencySession(dependencies);
    return beginSelectedReplay(step, content, tools, planning);
  }
  if (!report.runtime) {
    clearDependencySession(dependencies);
    return {
      text: `${step.id} needs Python 3 before its dependencies can be installed. Install Python 3, then repeat the exercise prompt. No files were changed.`,
      stopReason: "end_turn",
      exerciseId: step.id,
    };
  }
  return dependencyQuestion(step, report, tools, dependencies);
}

function noExerciseReply(): Reply {
  return { text: "No exercise selected. Nothing was changed or recorded.", stopReason: "end_turn" };
}

function replayCompletion(
  step: ReplayStep,
  content: Content,
  detail: string,
  active?: ActivePlanPath,
  recordProgress = true,
): Reply {
  const example = content.examples.find((candidate) => candidate.id === step.exampleId);
  if (recordProgress) {
    markIfNew(step.exampleId, {
      via: "agent",
      agent: "claude",
      ...(active?.kind === "authored"
        ? { variant: { kind: "authored" as const, answers: active.answers } }
        : {}),
    });
  }
  if (!recordProgress) {
    return {
      text: "Build and verification finished. The program is ready for you to run.",
      stopReason: "end_turn",
      exerciseId: step.id,
      nativeReady: true,
    };
  }
  const explanation = example ? renderBookEnvelope(example, step, "complete") : "AI First replay completed.";
  if (active?.replay.events || step.replay?.events) {
    return {
      text: replayTrailingText(active?.replay ?? step.replay) || explanation,
      stopReason: "end_turn",
      exerciseId: step.id,
    };
  }
  return {
    text: `${detail ? `${detail}\n\n` : ""}---\n\n${explanation}`,
    stopReason: "end_turn",
    exerciseId: step.id,
  };
}

/** Blocks a client injects around what the reader typed. */
const INJECTED = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const SESSION = /<session>([\s\S]*?)<\/session>/i;
const INTERRUPTED_TOOL_USE = "[Request interrupted by user for tool use]";

function readerBlockText(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim() !== INTERRUPTED_TOOL_USE)
    .join("\n");
}

function isSessionTitleRequest(messages: RequestMessage[] | undefined): boolean {
  const last = [...(messages ?? [])].reverse().find((message) => message.role === "user");
  const raw = typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
  return SESSION.test(raw) && /write the title|session title/i.test(raw);
}

/**
 * What the reader actually typed, out of the last user turn.
 *
 * A client's user message carries more than the reader's words — reminders,
 * file context, tool results. Matching against all of it would let a short book
 * prompt match incidentally, because the matcher accepts one string containing
 * the other.
 */
export function readerText(messages: RequestMessage[] | undefined): string {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  if (!last) return "";

  const raw =
    typeof last.content === "string"
      ? readerBlockText(last.content)
      : (last.content ?? [])
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => readerBlockText(b.text as string))
          .join("\n");

  const session = raw.match(SESSION);
  return (session ? session[1] : raw).replace(INJECTED, "").trim();
}

function displayedReplay(messages: RequestMessage[] | undefined, content: Content): ReplayStep | undefined {
  const assistant = [...(messages ?? [])].reverse().find((message) => message.role === "assistant");
  if (!assistant) return undefined;
  const text = typeof assistant.content === "string"
    ? assistant.content
    : (assistant.content ?? []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
  const shown = text.match(/A replay may match this prompt:\s*([^\n]+)/i)?.[1]?.trim();
  if (!shown) return undefined;
  return content.steps.find((candidate) => {
    const step = candidate as ReplayStep;
    return step.replay && normalizedPrompt(step.replay.prompt ?? step.prompt) === normalizedPrompt(shown);
  }) as ReplayStep | undefined;
}

function normalizedPrompt(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function isEmptyContinuation(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "(no content)" || normalized === "no content";
}

/** The result of a tool we asked the client to run, if that is what just arrived. */
export function toolResult(
  messages: RequestMessage[] | undefined,
): { failed: boolean; detail: string } | undefined {
  const block = latestToolResult(messages);
  if (!block) return undefined;

  const raw = block.content;
  const detail =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? (raw as ContentBlock[])
            .filter((b) => typeof b?.text === "string")
            .map((b) => b.text as string)
            .join("\n")
        : "";
  return { failed: block.is_error === true, detail: detail.trim() };
}

/** Did the client just hand back the result of a tool we asked it to run? */
export function carriesToolResult(messages: RequestMessage[] | undefined): boolean {
  return toolResult(messages) !== undefined;
}


/**
 * What to say once the exercise has run — or failed to.
 *
 * The command's result is checked rather than assumed. Saying "recorded" because a
 * tool call came back is how a reader ends up with a green tick for code that never
 * ran, which is a bug this project has already shipped once.
 */
function closing(log: ProgressLog, content: Content, result: { failed: boolean; detail: string }): string {
  const done = Object.values(log.exercises).filter((e) => e.status === "done").length;
  const total = content.examples.length;

  if (result.failed) {
    const approval = /requires approval|permission/i.test(result.detail);
    const lines = [
      approval
        ? "That was not allowed to run, so nothing has been recorded."
        : "That did not run cleanly, so nothing has been recorded.",
    ];
    if (result.detail) {
      lines.push("", "```", result.detail.slice(0, 500), "```");
    }
    lines.push(
      "",
      approval
        ? "Approve it, or run `aifirst init` once to pre-approve the aifirst commands."
        : "Fix it and ask again, or run the command yourself to see the full output.",
    );
    return lines.join("\n");
  }

  return [
    `Ran clean — ${done} of ${total} exercises done.`,
    "",
    "Ask for the next one, or run `aifirst next` yourself.",
  ].join("\n");
}

/**
 * The refusal.
 *
 * Book mode answers from the pack or not at all. Quietly forwarding an unmatched
 * question to the real API would spend the reader's money in a mode they turned on
 * precisely so that it wouldn't, so the reply says what happened and how to leave.
 */
function refusal(typed: string): string {
  const asked = typed.length > 0 && typed.length < 120 ? `“${typed}” ` : "";
  return [
    `Book mode is on, and ${asked}isn't a prompt from the book.`,
    "",
    "It answers only what the books contain, from content shipped with the CLI —" +
      " no model is running and nothing leaves this machine, which is why it costs nothing.",
    "",
    "You can:",
    "- ask for an exercise using its prompt from the page, or by id (`py-1-01`)",
    "- type `aifirst next` (no leading slash) to see what's next",
    "- run `aifirst book-mode off` to go back to the real Claude, which costs the usual",
  ].join("\n");
}

function chatReply(
  typed: string,
  content: Content,
  log: ProgressLog,
  tools: ToolDefinition[] | undefined,
  language: string | undefined,
): Reply | undefined {
  const command = parseChatCommand(typed);
  if (!command) {
    return /\baifirst\b/i.test(typed)
      ? { text: chatCommandError(""), stopReason: "end_turn" }
      : undefined;
  }
  if (!isLocalCommand(command.command)) {
    return { text: chatCommandError(command.command), stopReason: "end_turn" };
  }
  if (command.command === "help") return { text: localHelp(), stopReason: "end_turn" };

  if (command.command === "show" || command.command === "prompt") {
    const id = command.positionals[0];
    const step = id ? content.steps.find((item) => item.id === id) : undefined;
    const example = step ? content.examples.find((item) => item.id === step.exampleId) : undefined;
    if (step && example) return { text: renderStep(example, step), stopReason: "end_turn", exerciseId: step.id };
    return { text: "local learning could not find that exercise. Try `aifirst show py-1-01`.", stopReason: "end_turn" };
  }

  if (command.command === "next") {
    const next = content.examples.find(
      (example) => !log.exercises[example.id] && (!language || example.language === language),
    );
    if (!next) return { text: "No next exercise is available.", stopReason: "end_turn" };
    const step = content.steps.find((item) => item.exampleId === next.id);
    if (!step) return { text: "local learning could not find the next exercise content.", stopReason: "end_turn" };
    const tool = shellTool(tools);
    const commandText = `aifirst run ${step.id}`;
    return {
      text: [
        renderStep(next, step),
        "",
        "## Instruction",
        "",
        step.prompt,
        ...(tool ? [] : ["", "Run it with:", "", "```", commandText, "```"]),
      ].join("\n"),
      ...(tool
        ? {
            toolUse: {
              name: tool,
              input: { command: commandText, description: `Run ${step.id} and record it` },
              nativeAction: { kind: "run-exercise", stepId: step.id },
            },
          }
        : {}),
      stopReason: tool ? "tool_use" : "end_turn",
      exerciseId: next.id,
    };
  }

  return {
    text: `local learning accepts \`aifirst ${command.command}\`. Run the same command in your terminal for its full output.`,
    stopReason: "end_turn",
  };
}

export interface RespondOptions {
  /** Restrict matching to the reader's book, so a Python reader never gets Java. */
  language?: string;
  /** Transaction state owned by one running book server. */
  confirmation?: ConfirmationState;
  /** Interactive, model-free planning state owned by one local server. */
  planning?: PlanningSession;
  /** Missing-package confirmation/install state owned by one local server. */
  dependencies?: DependencySession;
  /** Test seam for deterministic dependency availability. */
  dependencyCheck?: DependencyCheck;
  /** Built-in TUI/plain learner defers progress until Run or Finish without running. */
  deferNativeCompletion?: boolean;
  /** Native execution trusts the captured exit code across platform-specific output noise. */
  relaxCommandOutput?: boolean;
}

/**
 * The book pack's own matching logic, wrapped behind the ContentSource seam.
 *
 * A 1:1 wrap of what `respond()` did inline before this seam existed: find the
 * matching step, render it, and offer the client's own shell tool to run it.
 */
export class BookContentSource implements ContentSource {
  constructor(
    private readonly content: Content,
    private readonly tools: ToolDefinition[] | undefined,
    private readonly language: string | undefined,
  ) {}

  next(typed: string): SourceReply | undefined {
    const stored = readPendingReplay();
    if (stored && stored.stepIds.length > 1) {
      const selection = replaySelection(typed, stored.stepIds);
      if (selection === "cancel") {
        clearPendingReplay();
        return noExerciseReply();
      }
      if (selection) {
        clearPendingReplay();
        const step = this.content.steps.find((candidate) => candidate.id === selection) as ReplayStep | undefined;
        if (step?.replay && (!this.language || step.language === this.language)) return this.execute(step);
      }
      const candidates = stored.stepIds.flatMap((id) => {
        const step = this.content.steps.find((candidate) => candidate.id === id) as ReplayStep | undefined;
        return step?.replay ? [{ step, score: 0 }] : [];
      });
      return { text: ambiguityText(this.content, candidates), stopReason: "end_turn" as const };
    }

    const confirmation = confirmationAnswer(typed);
    const pending = confirmation ? readPendingReplay() : undefined;
    if (confirmation && !pending) {
      return {
        text: "That replay confirmation is no longer available. Please repeat the exercise prompt so I can match it again.",
        stopReason: "end_turn" as const,
      };
    }
    if (confirmation === "no" && pending) {
      clearPendingReplay();
      return { text: "Replay cancelled.", stopReason: "end_turn" as const };
    }
    if (confirmation === "yes" && pending) {
      clearPendingReplay();
      const step = this.content.steps.find((candidate) => candidate.id === pending.stepIds[0]) as ReplayStep | undefined;
      if (step?.replay && (!this.language || step.language === this.language)) return this.execute(step);
    }

    const replay = resolveReplay(typed, this.content, this.language);
    if (replay.kind === "fuzzy") {
      savePendingReplay(replay.step.id);
      return {
        text: `A replay may match this prompt: ${replay.step.prompt}\n\nReply "yes" to run it, or continue with a different prompt.`,
        stopReason: "end_turn" as const,
      };
    }
    if (replay.kind === "ambiguous") {
      savePendingReplay(replay.candidates.map((candidate) => candidate.step.id));
      return ambiguityReply(this.content, replay.candidates, this.tools);
    }
    if (replay.kind === "exact") {
      clearPendingReplay();
      return this.execute(replay.step);
    }
    const step = typed ? findMatchingStep(typed, this.content.steps, this.language) : null;
    if (!step) return undefined;

    const example = this.content.examples.find((e) => e.id === step.exampleId);
    if (!example) {
      // A step whose example is missing is a content bug, not something to dress
      // up as an answer.
      return undefined;
    }

    const tool = shellTool(this.tools);
    const command = `aifirst run ${step.id}`;
    if (!tool) {
      // No shell tool on offer: still give the reader the answer and the
      // command, rather than a tool call the client cannot execute.
      return {
        text: `${renderStep(example, step)}\n\nRun it with:\n\n\`\`\`\n${command}\n\`\`\``,
        stopReason: "end_turn" as const,
        exerciseId: step.id,
      };
    }

    return {
      text: renderStep(example, step),
      toolUse: {
        name: tool,
        input: { command, description: `Run ${step.id} and record it` },
        nativeAction: { kind: "run-exercise", stepId: step.id },
      },
      stopReason: "tool_use" as const,
      exerciseId: step.id,
    };
  }

  private execute(step: ReplayStep) {
    const example = this.content.examples.find((candidate) => candidate.id === step.exampleId);
    if (!example || !step.replay) return undefined;
    writeScaffold(process.cwd(), step, this.content, { binaryOnly: true });
    const result = executeReplay(step.replay);
    return {
      text: [renderStep(example, step), result.text, result.ok ? "Replay completed." : "Replay diverged from its recorded result."].filter(Boolean).join("\n\n"),
      stopReason: "end_turn" as const,
      exerciseId: step.id,
    };
  }
}

/** Decide what book mode replies to one request. */
export function respond(
  request: MessagesRequest,
  content: Content,
  log: ProgressLog,
  options: RespondOptions = {},
  source: ContentSource = new BookContentSource(content, request.tools, options.language),
): Reply {
  if (isSessionTitleRequest(request.messages)) {
    const typed = readerText(request.messages);
    const match = resolveReplay(typed, content, options.language);
    const step = match.kind === "exact" ? match.step : undefined;
    const example = step ? content.examples.find((candidate) => candidate.id === step.exampleId) : undefined;
    return { text: example?.title ?? "AI First learning", stopReason: "end_turn", exerciseId: step?.id };
  }

  const dependencyInstall = dependencyInstallResult(request.messages, options.dependencies?.installToolId);
  if (dependencyInstall && options.dependencies?.stepId) {
    const step = content.steps.find((candidate) => candidate.id === options.dependencies!.stepId) as ReplayStep | undefined;
    if (!step?.replay) {
      clearDependencySession(options.dependencies);
      return { text: "That dependency installation is no longer attached to an exercise.", stopReason: "end_turn" };
    }
    if (dependencyInstall.failed) {
      clearDependencySession(options.dependencies);
      return {
        text: `Dependency installation failed. No exercise files were changed.${dependencyInstall.detail ? `\n\n${dependencyInstall.detail}` : ""}`,
        stopReason: "end_turn",
        exerciseId: step.id,
      };
    }
    const report = (options.dependencyCheck ?? ((candidate) => checkDependencies(candidate.dependencies)))(step);
    if (report.missing.length > 0) {
      clearDependencySession(options.dependencies);
      return {
        text: `Dependency installation finished, but ${dependencyNames(report.missing)} is still unavailable. No exercise files were changed.`,
        stopReason: "end_turn",
        exerciseId: step.id,
      };
    }
    clearDependencySession(options.dependencies);
    return selectedReplayReply(
      step,
      content,
      request.tools,
      options.planning,
      options.dependencies,
      options.dependencyCheck,
    );
  }

  const dependencyConfirmation = dependencyConfirmationResult(
    request.messages,
    options.dependencies?.confirmationToolId,
  );
  if (dependencyConfirmation && options.dependencies?.stepId) {
    const step = content.steps.find((candidate) => candidate.id === options.dependencies!.stepId) as ReplayStep | undefined;
    if (!step?.replay || dependencyConfirmation.failed || !dependencyConfirmation.accepted) {
      clearDependencySession(options.dependencies);
      return {
        text: dependencyConfirmation.failed ? "Dependency installation was cancelled." : "Exercise cancelled. No files were changed.",
        stopReason: "end_turn",
        exerciseId: step?.id,
      };
    }
    const shell = shellTool(request.tools);
    if (!shell) {
      clearDependencySession(options.dependencies);
      return {
        text: `Install the dependencies with \`aifirst dependencies install ${step.id}\`, then repeat the exercise prompt. No files were changed.`,
        stopReason: "end_turn",
        exerciseId: step.id,
      };
    }
    delete options.dependencies.confirmationToolId;
    options.dependencies.installToolId = `${DEPENDENCY_INSTALL_PREFIX}${step.id.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
    return {
      text: `Installing ${dependencyNames(step.dependencies)} before starting ${step.id}.`,
      toolUse: {
        id: options.dependencies.installToolId,
        name: shell,
        input: {
          command: `aifirst dependencies install ${step.id} --yes --format json`,
          description: `Install dependencies for ${step.id}`,
        },
        nativeAction: { kind: "install-dependencies", stepId: step.id },
      },
      stopReason: "tool_use",
      exerciseId: step.id,
    };
  }

  const dependencyConfirmationResults = interactiveToolResults(request.messages, DEPENDENCY_CONFIRM_PREFIX);
  if (
    dependencyConfirmationResults.length > 0 &&
    options.dependencies?.stepId &&
    options.dependencies.confirmationToolId &&
    isEmptyContinuation(readerText(request.messages))
  ) {
    const step = content.steps.find((candidate) => candidate.id === options.dependencies!.stepId) as ReplayStep | undefined;
    if (step?.replay) {
      const report = (options.dependencyCheck ?? ((candidate) => checkDependencies(candidate.dependencies)))(step);
      if (report.missing.length > 0) return dependencyQuestion(step, report, request.tools, options.dependencies);
    }
  }

  const interludeResult = interludeToolResult(request.messages);
  if (interludeResult && options.planning) {
    const step = planningStep(
      content.steps.find((candidate) => candidate.id === interludeResult.stepId) as ReplayStep | undefined,
      options.planning,
    );
    const segment = eventSegments(step ? workflowInterludeEvents(step, interludeResult.questionId) : [])[interludeResult.operationIndex];
    if (!step?.replay?.workflow || !segment || !operationResultMatches(segment.operation, interludeResult, options.relaxCommandOutput)) {
      return {
        text: replayMismatch("planning ", interludeResult.operationIndex + 1, interludeResult.detail),
        stopReason: "end_turn",
        exerciseId: step?.id,
      };
    }
    return planningInterludeReply(step, content, request.tools, options.planning, interludeResult.questionId, interludeResult.operationIndex + 1);
  }

  const prePlanResult = prePlanToolResult(request.messages);
  if (prePlanResult && options.planning) {
    const step = content.steps.find((candidate) => candidate.id === prePlanResult.stepId) as ReplayStep | undefined;
    const segment = prePlanSegments(step?.replay)[prePlanResult.operationIndex];
    if (!step?.replay?.workflow || !segment || !operationResultMatches(segment.operation, prePlanResult, options.relaxCommandOutput)) {
      return {
        text: replayMismatch("pre-plan ", prePlanResult.operationIndex + 1, prePlanResult.detail),
        stopReason: "end_turn",
        exerciseId: step?.id,
      };
    }
    return prePlanReply(step, content, request.tools, options.planning, prePlanResult.operationIndex + 1);
  }

  const hasPlanningToolResult = carriesPlanningToolResult(request.messages);
  let cancelledPlanningTool = false;
  let ignoredStalePlanning = false;
  if (options.planning?.stepId && planningToolCancelled(request.messages, options.planning.expectedToolId)) {
    clearActivePlanning(options.planning);
    cancelledPlanningTool = true;
    if (isEmptyContinuation(readerText(request.messages))) {
      return {
        text: "Planning cancelled. No files were changed and no progress was recorded.",
        stopReason: "end_turn",
      };
    }
  }

  const planAnswer = cancelledPlanningTool
    ? undefined
    : planningToolResult(request.messages, options.planning?.expectedToolId);
  if (planAnswer !== undefined && options.planning?.stepId) {
    const step = planningStep(
      content.steps.find((candidate) => candidate.id === options.planning!.stepId) as ReplayStep | undefined,
      options.planning,
    );
    if (step?.replay?.workflow) {
      const outcome = continuePlanning(step, options.planning, request.tools, planAnswer);
      return planningOutcomeReply(step, content, request.tools, options.planning, outcome);
    }
  }
  if (!cancelledPlanningTool && planAnswer === undefined && hasPlanningToolResult && options.planning?.stepId) {
    ignoredStalePlanning = true;
    if (isEmptyContinuation(readerText(request.messages))) {
      const step = planningStep(
        content.steps.find((candidate) => candidate.id === options.planning!.stepId) as ReplayStep | undefined,
        options.planning,
      );
      if (step?.replay?.workflow) {
        const outcome = repeatPlanning(step, options.planning, request.tools);
        return planningOutcomeReply(step, content, request.tools, options.planning, outcome);
      }
    }
  }

  const ambiguityResult = ambiguityToolResult(request.messages, options.confirmation?.ambiguityToolId);
  if (ambiguityResult) {
    const stepIds = pendingConfirmationIds(options.confirmation);
    const selection = ambiguityResult.failed ? "cancel" : replaySelection(ambiguityResult.answer, stepIds);
    clearConfirmation(options.confirmation);
    if (!selection || selection === "cancel") return noExerciseReply();
    const step = content.steps.find((candidate) => candidate.id === selection) as ReplayStep | undefined;
    return selectedReplayReply(step, content, request.tools, options.planning, options.dependencies, options.dependencyCheck);
  }

  let ignoredStaleConfirmation = false;
  const pendingConfirmation = pendingConfirmationIds(options.confirmation);
  const confirmationResults = interactiveToolResults(request.messages, CONFIRMATION_TOOL_PREFIX);
  const confirmationResult = confirmationToolResult(request.messages, options.confirmation?.confirmationToolId);
  if (confirmationResult) {
    const stepId = pendingConfirmation[0];
    const step = stepId
      ? content.steps.find((candidate) => candidate.id === stepId) as ReplayStep | undefined
      : undefined;
    clearConfirmation(options.confirmation);
    if (confirmationResult.failed) {
      return { text: "Replay confirmation was cancelled.", stopReason: "end_turn", exerciseId: step?.id };
    }
    if (!confirmationResult.accepted) {
      return { text: "Replay cancelled.", stopReason: "end_turn", exerciseId: step?.id };
    }
    return selectedReplayReply(step, content, request.tools, options.planning, options.dependencies, options.dependencyCheck);
  }
  if (confirmationResults.length > 0 && pendingConfirmation.length === 1) {
    ignoredStaleConfirmation = true;
    if (isEmptyContinuation(readerText(request.messages))) {
      const step = content.steps.find((candidate) => candidate.id === pendingConfirmation[0]) as ReplayStep | undefined;
      if (!step?.replay) {
        clearConfirmation(options.confirmation);
        return { text: "That replay confirmation is no longer available. Please repeat the exercise prompt.", stopReason: "end_turn" };
      }
      const question = confirmationQuestion(step, request.tools, options.confirmation?.confirmationToolId);
      return {
        text: question
          ? `I still need your choice for ${step.id}.`
          : `A replay may match this prompt: ${step.replay.prompt ?? step.prompt}\n\nReply "yes" to run it, or "no" to do nothing.`,
        ...(question ? { toolUse: question } : {}),
        stopReason: question ? "tool_use" : "end_turn",
        exerciseId: step.id,
      };
    }
  }

  const replayResult = replayToolResult(request.messages);
  if (replayResult) {
    const step = content.steps.find((candidate) => candidate.id === replayResult.stepId) as ReplayStep | undefined;
    const planning = options.planning;
    const active = planning?.active;
    const matchingActive = active?.stepId === step?.id ? active : undefined;
    const replay = matchingActive?.replay ?? (
      step?.replay
        ? replayResult.standalone
          ? standaloneReplay(step.replay)
          : step.replay
        : undefined
    );
    if (!step?.replay || !replayResultMatches(step, replayResult.operationIndex, replayResult, replay, options.relaxCommandOutput)) {
      if (options.planning) clearActivePlanning(options.planning);
      return {
        text: replayMismatch("", replayResult.operationIndex + 1, replayResult.detail),
        stopReason: "end_turn",
        exerciseId: step?.id,
      };
    }
    const next = replayResult.operationIndex + 1;
    if (next < replaySegments(replay).length) {
      return nativeReplayReply(step, content, request.tools, next, replay, replayResult.standalone);
    }
    const completed = replayCompletion(
      step,
      content,
      replayResult.detail,
      matchingActive,
      !options.deferNativeCompletion,
    );
    if (options.planning) clearActivePlanning(options.planning);
    return completed;
  }

  const result = toolResult(request.messages);
  if (result && !cancelledPlanningTool && !ignoredStalePlanning && !ignoredStaleConfirmation) {
    if (options.deferNativeCompletion && !result.failed) {
      return {
        text: "The code is ready for you to run.",
        stopReason: "end_turn",
        nativeReady: true,
      };
    }
    return { text: closing(log, content, result), stopReason: "end_turn" };
  }

  const typed = readerText(request.messages);
  if (typed && options.planning?.stepId && options.planning.awaiting) {
    const replacement = resolveReplay(typed, content, options.language);
    if (replacement.kind !== "none") {
      clearActivePlanning(options.planning);
    } else {
      const step = planningStep(
        content.steps.find((candidate) => candidate.id === options.planning!.stepId) as ReplayStep | undefined,
        options.planning,
      );
      if (step?.replay?.workflow) {
        const outcome = continuePlanning(step, options.planning, request.tools, typed);
        return planningOutcomeReply(step, content, request.tools, options.planning, outcome);
      }
    }
  }

  const pendingIds = pendingConfirmationIds(options.confirmation);
  if (pendingIds.length > 1) {
    const selection = replaySelection(typed, pendingIds);
    if (selection === "cancel") {
      clearConfirmation(options.confirmation);
      return noExerciseReply();
    }
    if (selection) {
      clearConfirmation(options.confirmation);
      const step = content.steps.find((candidate) => candidate.id === selection) as ReplayStep | undefined;
      return selectedReplayReply(step, content, request.tools, options.planning, options.dependencies, options.dependencyCheck);
    }
    const candidates = pendingIds.flatMap((id) => {
      const step = content.steps.find((candidate) => candidate.id === id) as ReplayStep | undefined;
      return step?.replay ? [{ step, score: 0 }] : [];
    });
    return ambiguityReply(content, candidates, request.tools, options.confirmation?.ambiguityToolId);
  }
  if (pendingIds.length === 1 && isEmptyContinuation(typed)) {
    const step = content.steps.find((candidate) => candidate.id === pendingIds[0]) as ReplayStep | undefined;
    if (!step?.replay) {
      clearConfirmation(options.confirmation);
      return { text: "That replay confirmation is no longer available. Please repeat the exercise prompt.", stopReason: "end_turn" };
    }
    const question = confirmationQuestion(step, request.tools, options.confirmation?.confirmationToolId);
    return {
      text: question
        ? `I still need your choice for ${step.id}.`
        : `A replay may match this prompt: ${step.replay.prompt ?? step.prompt}\n\nReply "yes" to run it, or "no" to do nothing.`,
      ...(question ? { toolUse: question } : {}),
      stopReason: question ? "tool_use" : "end_turn",
      exerciseId: step.id,
    };
  }
  const chat = chatReply(typed, content, log, request.tools, options.language);
  if (chat) return chat;

  const answer = confirmationAnswer(typed);
  const shown = answer ? displayedReplay(request.messages, content) : undefined;
  const pending = answer ? readPendingReplay() : undefined;
  const pendingId = confirmationIds(options.confirmation)[0] ?? pending?.stepIds[0];
  const pendingStep = pendingId
    ? content.steps.find((candidate) => candidate.id === pendingId) as ReplayStep | undefined
    : undefined;
  const confirmedStep = shown ?? pendingStep;
  if (answer && !confirmedStep) {
    return {
      text: "That replay confirmation is no longer available. Please repeat the exercise prompt so I can match it again.",
      stopReason: "end_turn",
    };
  }
  if (answer === "no" && confirmedStep) {
    clearConfirmation(options.confirmation);
    return noExerciseReply();
  }
  if (answer === "yes" && confirmedStep) {
    clearConfirmation(options.confirmation);
    return selectedReplayReply(confirmedStep, content, request.tools, options.planning, options.dependencies, options.dependencyCheck);
  }

  const replay = resolveReplay(typed, content, options.language);
  if (replay.kind === "fuzzy") {
    // A confirmation is transactional: duplicate/overlapping requests must
    // not replace the candidate already shown to the reader.
    const existingId = pendingConfirmationIds(options.confirmation)[0];
    const pendingStep = existingId
      ? content.steps.find((candidate) => candidate.id === existingId) as ReplayStep | undefined
      : undefined;
    const candidate = pendingStep?.replay ? pendingStep : replay.step;
    setConfirmation(options.confirmation, [candidate.id]);
    const question = confirmationQuestion(candidate, request.tools, options.confirmation?.confirmationToolId);
    if (question) {
      return {
        text: `I found a likely replay for ${candidate.id}.`,
        toolUse: question,
        stopReason: "tool_use",
        exerciseId: candidate.id,
      };
    }
    return {
      text: `A replay may match this prompt: ${candidate.replay?.prompt ?? candidate.prompt}\n\nReply "yes" to run it, or continue with a different prompt.`,
      stopReason: "end_turn",
      exerciseId: candidate.id,
    };
  }
  if (replay.kind === "ambiguous") {
    const existingIds = pendingConfirmationIds(options.confirmation);
    const candidates = existingIds.length > 1
      ? existingIds.flatMap((id) => {
          const step = content.steps.find((candidate) => candidate.id === id) as ReplayStep | undefined;
          return step?.replay ? [{ step, score: 0 }] : [];
        })
      : replay.candidates;
    setConfirmation(options.confirmation, candidates.map((candidate) => candidate.step.id));
    return ambiguityReply(content, candidates, request.tools, options.confirmation?.ambiguityToolId);
  }
  if (replay.kind === "exact" && replay.step.replay?.workflow && options.planning) {
    return selectedReplayReply(replay.step, content, request.tools, options.planning, options.dependencies, options.dependencyCheck);
  }
  if (replay.kind === "exact" && replay.step.replay) {
    const mode = workspaceMatchesInitialState(replay.step, content) ? "captured" : "standalone";
    const selected = replayStepForMode(replay.step, mode);
    const needsDependencyGate = Boolean(options.dependencies && replay.step.dependencies?.length);
    if (needsDependencyGate || replayToolUse(selected, 0, request.tools, selected.replay, "replay", mode === "standalone")) {
      return selectedReplayReply(replay.step, content, request.tools, options.planning, options.dependencies, options.dependencyCheck);
    }
  }

  const state: SourceState = {};
  const reply = source.next(typed, state);
  if (!reply) {
    return { text: refusal(typed), stopReason: "end_turn" };
  }
  return reply;
}
