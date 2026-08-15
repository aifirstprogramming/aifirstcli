import type { Content } from "../content/types";
import type { ProgressLog } from "../log/progress";

export interface SourceState {
  content?: Content;
  log?: ProgressLog;
  language?: string;
  stepIndex?: number;
}
export interface SourceReply {
  text: string;
  exerciseId?: string;
  toolUse?: { name: string; input: Record<string, unknown> };
  stopReason: "end_turn" | "tool_use";
}
export interface ContentSource {
  next(typed: string, state: SourceState): SourceReply | undefined;
}
