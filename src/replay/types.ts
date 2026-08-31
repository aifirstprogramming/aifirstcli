export interface ReplayStep {
  /** `${sessionId}-${index}`, stable across re-import. */
  id: string;
  /** Turn.prompt.text -- matched to the reader's typed prompt. */
  promptText: string;
  /** Turn.aiOutputs[].text, in order. */
  commentary: string[];
  codeChanges: { path: string; diff?: string }[];
  toolCalls: { toolName: string; isError?: boolean; text: string }[];
  /** Captured display order, present in packs imported from Showtail reports. */
  events?: ReplayEvent[];
  recap?: { durationMs?: number; inputTokens?: number; outputTokens?: number };
  /** Canonical executable operations when the report captured them. */
  replay?: import("../content/types").Replay;
}

export type ReplayEvent =
  | { kind: "commentary"; text: string; timestamp?: string }
  | { kind: "code_change"; path: string; diff?: string; timestamp?: string }
  | { kind: "tool_call"; toolName: string; isError?: boolean; text: string; timestamp?: string };

export interface ReplayPack {
  /** User-chosen at import, e.g. "csv-parser-demo". */
  name: string;
  sourceReportGeneratedAt: string;
  displayName: string;
  steps: ReplayStep[];
}
