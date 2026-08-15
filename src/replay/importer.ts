import type { ShowtailReport } from "./showtailReport";
import type { ReplayPack } from "./types";

/**
 * Convert a raw Showtail report into an ordered ReplayPack.
 *
 * One step per Turn, iterated in the order Showtail already sorted them
 * chronologically. A replay is a fixed script, not searchable exercises.
 */
export function buildReplayPack(name: string, report: ShowtailReport): ReplayPack {
  return {
    name,
    sourceReportGeneratedAt: report.generatedAt,
    displayName: report.displayName,
    steps: report.turns.map((turn, index) => ({
      id: `${report.sessionId ?? name}-${index}`,
      promptText: turn.prompt.text,
      commentary: turn.aiOutputs.map((output) => output.text),
      codeChanges: turn.codeChanges.map(({ path, diff }) => ({ path, diff })),
      toolCalls: turn.toolCalls.map(({ toolName, isError, text }) => ({ toolName, isError, text })),
      recap: turn.recap,
    })),
  };
}
