import { CliError } from "../output";

export interface ShowtailText { text: string; }
export interface ShowtailCodeChange { path: string; diff?: string; }
export interface ShowtailToolCall { toolName: string; isError?: boolean; text: string; }
export interface ShowtailTurn {
  prompt: ShowtailText;
  aiOutputs: ShowtailText[];
  codeChanges: ShowtailCodeChange[];
  toolCalls: ShowtailToolCall[];
  recap?: { durationMs?: number; inputTokens?: number; outputTokens?: number };
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
  return { text: record.text };
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
      return { path: item.path, diff: typeof item.diff === "string" ? item.diff : undefined };
    }) : [];
    const toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls.map((v) => {
      const item = object(v);
      if (typeof item.toolName !== "string") throw new CliError(`Report field turns[${index}].toolCalls.toolName is missing or invalid`, "bad_report");
      if (typeof item.text !== "string") throw new CliError(`Report field turns[${index}].toolCalls.text is missing or invalid`, "bad_report");
      return { toolName: item.toolName, isError: item.isError === true, text: item.text };
    }) : [];
    return { prompt, aiOutputs, codeChanges, toolCalls, recap: turn.recap as ShowtailTurn["recap"] | undefined };
  });
  return { turns, generatedAt: record.generatedAt, displayName: record.displayName, sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined };
}
