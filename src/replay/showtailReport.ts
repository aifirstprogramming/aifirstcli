import { CliError } from "../output";
import type { ReplayOperation } from "../content/types";

export interface ShowtailText { text: string; timestamp?: string; }
export interface ShowtailCodeChange { path: string; diff?: string; timestamp?: string; }
export interface ShowtailToolCall { toolName: string; isError?: boolean; text: string; timestamp?: string; }
export interface ShowtailTurn {
  prompt: ShowtailText;
  aiOutputs: ShowtailText[];
  codeChanges: ShowtailCodeChange[];
  toolCalls: ShowtailToolCall[];
  recap?: { durationMs?: number; inputTokens?: number; outputTokens?: number };
  operations?: ReplayOperation[];
}
export interface ShowtailReport {
  turns: ShowtailTurn[];
  generatedAt: string;
  displayName: string;
  sessionId?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("Report must be an object", "bad_report");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): ShowtailText {
  const record = object(value);
  if (typeof record.text !== "string") throw new CliError(`Report field ${field}.text is missing or invalid`, "bad_report");
  return { text: record.text, timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined };
}
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function recap(value: unknown): ShowtailTurn["recap"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    durationMs: optionalNumber(record.durationMs),
    inputTokens: optionalNumber(record.inputTokens),
    outputTokens: optionalNumber(record.outputTokens),
  };
}
function operations(value: unknown, field: string): ReplayOperation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new CliError(`Report field ${field} must be an array`, "bad_report");
  return value.map((entry, index) => {
    const item = object(entry);
    if (item.type === "write") {
      if (typeof item.path !== "string" || typeof item.content !== "string") throw new CliError(`Report field ${field}[${index}] is an invalid write operation`, "bad_report");
      return { type: "write", path: item.path, content: item.content };
    }
    if (item.type === "edit") {
      if (typeof item.path !== "string" || typeof item.oldText !== "string" || typeof item.newText !== "string") throw new CliError(`Report field ${field}[${index}] is an invalid edit operation`, "bad_report");
      return { type: "edit", path: item.path, oldText: item.oldText, newText: item.newText, ...(item.replaceAll === true ? { replaceAll: true } : {}) };
    }
    if (item.type === "read") {
      if (typeof item.path !== "string") throw new CliError(`Report field ${field}[${index}] is an invalid read operation`, "bad_report");
      return { type: "read", path: item.path };
    }
    if (item.type === "command") {
      if (!Array.isArray(item.command) || item.command.length === 0 || !item.command.every((part) => typeof part === "string")) throw new CliError(`Report field ${field}[${index}] is an invalid command operation`, "bad_report");
      return {
        type: "command",
        command: item.command as string[],
        ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
        ...(item.env && typeof item.env === "object" && !Array.isArray(item.env) ? { env: item.env as Record<string, string> } : {}),
        ...(typeof item.stdin === "string" ? { stdin: item.stdin } : {}),
        ...(item.readOnly === true ? { readOnly: true } : {}),
        ...(typeof item.expectedExitCode === "number" ? { expectedExitCode: item.expectedExitCode } : {}),
        ...(typeof item.expectedStdout === "string" ? { expectedStdout: item.expectedStdout } : {}),
        ...(typeof item.expectedStderr === "string" ? { expectedStderr: item.expectedStderr } : {}),
      };
    }
    throw new CliError(`Report field ${field}[${index}] has an unknown operation type`, "bad_report");
  });
}
export function parseShowtailReport(raw: unknown): ShowtailReport {
  const record = object(raw);
  if (!Array.isArray(record.turns)) throw new CliError("Report field turns is missing or invalid", "bad_report");
  if (typeof record.generatedAt !== "string") throw new CliError("Report field generatedAt is missing or invalid", "bad_report");
  if (typeof record.displayName !== "string") throw new CliError("Report field displayName is missing or invalid", "bad_report");
  const turns = record.turns.map((value, index) => {
    const turn = object(value);
    const prompt = text(turn.prompt, `turns[${index}].prompt`);
    const aiOutputs = Array.isArray(turn.aiOutputs) ? turn.aiOutputs.map((v) => text(v, `turns[${index}].aiOutputs`)) : [];
    const codeChanges = Array.isArray(turn.codeChanges) ? turn.codeChanges.map((v) => {
      const item = object(v);
      if (typeof item.path !== "string") throw new CliError(`Report field turns[${index}].codeChanges.path is missing or invalid`, "bad_report");
      return {
        path: item.path,
        diff: typeof item.diff === "string" ? item.diff : undefined,
        timestamp: typeof item.timestamp === "string" ? item.timestamp : undefined,
      };
    }) : [];
    const toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls.map((v) => {
      const item = object(v);
      if (typeof item.toolName !== "string") throw new CliError(`Report field turns[${index}].toolCalls.toolName is missing or invalid`, "bad_report");
      if (typeof item.text !== "string") throw new CliError(`Report field turns[${index}].toolCalls.text is missing or invalid`, "bad_report");
      return {
        toolName: item.toolName,
        isError: item.isError === true,
        text: item.text,
        timestamp: typeof item.timestamp === "string" ? item.timestamp : undefined,
      };
    }) : [];
    return { prompt, aiOutputs, codeChanges, toolCalls, recap: recap(turn.recap), operations: operations(turn.operations, `turns[${index}].operations`) };
  });
  return { turns, generatedAt: record.generatedAt, displayName: record.displayName, sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined };
}
