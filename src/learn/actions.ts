import type { ReplayOperation } from "../content/types";

/** Structured work for the built-in learner; never serialized to API clients. */
export type NativeLearnAction =
  | { kind: "run-exercise"; stepId: string }
  | { kind: "install-dependencies"; stepId: string }
  | { kind: "replay-operation"; operation: ReplayOperation };
