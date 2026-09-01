import type { Content } from "../content/types";
import type { ProgressLog } from "../log/progress";

import type { NativeLearnAction } from "../learn/actions";

export interface SourceState {
  content?: Content;
  log?: ProgressLog;
  language?: string;
  stepIndex?: number;
}
export interface SourceReply {
  text: string;
  exerciseId?: string;
  toolUse?: { id?: string; name: string; input: Record<string, unknown>; nativeAction?: NativeLearnAction };
  stopReason: "end_turn" | "tool_use";
}
export interface ContentSource {
  next(typed: string, state: SourceState): SourceReply | undefined;
}
