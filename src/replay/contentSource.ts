import type { ContentSource, SourceReply, SourceState } from "../bookmode/contentSource";
import type { ReplayPack } from "./types";

function render(step: ReplayPack["steps"][number]): string {
  const parts = [...step.commentary];
  for (const change of step.codeChanges) {
    if (change.diff) parts.push(`\n\`\`\`diff\n${change.diff}\n\`\`\``);
  }
  for (const call of step.toolCalls) {
    parts.push(`\n🛠️ **${call.toolName}**${call.isError ? " (error)" : ""}\n${call.text}`);
  }
  return parts.join("\n\n");
}

/** Plays a ReplayPack as a fixed script, independent of prompt wording. */
export class ReplayContentSource implements ContentSource {
  constructor(private readonly pack: ReplayPack) {}

  next(_typed: string, state: SourceState): SourceReply | undefined {
    const index = state.stepIndex ?? 0;
    const step = this.pack.steps[index];
    if (!step) return undefined;
    state.stepIndex = index + 1;
    return { text: render(step), exerciseId: step.id, stopReason: "end_turn" };
  }
}

export { render as renderReplayStep };
