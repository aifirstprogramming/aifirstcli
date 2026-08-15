import type { ContentSource, SourceReply, SourceState } from "../bookmode/contentSource";
import type { ReplayPack } from "./types";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { replayDir } from "../paths";

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
  constructor(private readonly pack: ReplayPack, private readonly persistent = true) {}

  next(_typed: string, state: SourceState): SourceReply | undefined {
    let index = state.stepIndex ?? 0;
    const bookmark = join(replayDir(), `${this.pack.name}.state.json`);
    if (this.persistent) {
      try {
        const saved = JSON.parse(readFileSync(bookmark, "utf8")) as { stepIndex?: unknown };
        if (Number.isInteger(saved.stepIndex) && (saved.stepIndex as number) >= 0) index = saved.stepIndex as number;
      } catch {
        // A missing bookmark starts from the beginning. Invalid state is ignored.
      }
    }
    const step = this.pack.steps[index];
    if (!step) return undefined;
    state.stepIndex = index + 1;
    if (this.persistent) {
      mkdirSync(replayDir(), { recursive: true });
      writeFileSync(bookmark, JSON.stringify({ stepIndex: index + 1 }) + "\n", { mode: 0o600 });
    }
    return { text: render(step), exerciseId: step.id, stopReason: "end_turn" };
  }
}

export { render as renderReplayStep };
