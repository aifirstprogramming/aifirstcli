import type { ShowtailReport } from "./showtailReport";
import type { ReplayEvent, ReplayPack } from "./types";

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
      events: orderedEvents(turn),
      recap: turn.recap,
      ...(turn.operations ? { replay: { prompt: turn.prompt.text, operations: turn.operations, commentary: turn.aiOutputs.map((output) => output.text) } } : {}),
    })),
  };
}

function orderedEvents(turn: ShowtailReport["turns"][number]): ReplayEvent[] {
  const events: { timestamp?: string; order: number; event: ReplayEvent }[] = [];
  let order = 0;
  for (const output of turn.aiOutputs) {
    events.push({ timestamp: output.timestamp, order: order++, event: { kind: "commentary", text: output.text, timestamp: output.timestamp } });
  }
  for (const change of turn.codeChanges) {
    events.push({ timestamp: change.timestamp, order: order++, event: { kind: "code_change", path: change.path, diff: change.diff, timestamp: change.timestamp } });
  }
  for (const call of turn.toolCalls) {
    events.push({ timestamp: call.timestamp, order: order++, event: { kind: "tool_call", toolName: call.toolName, isError: call.isError, text: call.text, timestamp: call.timestamp } });
  }
  return events
    .sort((a, b) => {
      if (a.timestamp && b.timestamp) return a.timestamp.localeCompare(b.timestamp) || a.order - b.order;
      if (a.timestamp) return -1;
      if (b.timestamp) return 1;
      return a.order - b.order;
    })
    .map(({ event }) => event);
}
