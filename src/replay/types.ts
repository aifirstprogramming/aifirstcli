export interface ReplayStep {
  /** `${sessionId}-${index}`, stable across re-import. */
  id: string;
  /** Turn.prompt.text -- matched to the reader's typed prompt. */
  promptText: string;
  /** Turn.aiOutputs[].text, in order. */
  commentary: string[];
  codeChanges: { path: string; diff?: string }[];
  toolCalls: { toolName: string; isError?: boolean; text: string }[];
  recap?: { durationMs?: number; inputTokens?: number; outputTokens?: number };
}

export interface ReplayPack {
  /** User-chosen at import, e.g. "csv-parser-demo". */
  name: string;
  sourceReportGeneratedAt: string;
  displayName: string;
  steps: ReplayStep[];
}
