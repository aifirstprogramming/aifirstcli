import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Content, Replay, ReplayOperation, ReplayStep } from "../content/types";

interface AuthoredTransition {
  before: Set<string>;
  afterOrLater: Set<string>;
}

export type ReplayFileDecision =
  | { kind: "execute" }
  | { kind: "already-applied"; path: string }
  | { kind: "reject"; path: string };

function operationKey(operation: Extract<ReplayOperation, { type: "write" | "edit" }>): string {
  return operation.type === "write"
    ? JSON.stringify(["write", operation.path, operation.content])
    : JSON.stringify(["edit", operation.path, operation.oldText, operation.newText, operation.replaceAll === true]);
}

function replaySequences(replay: Replay | undefined): ReplayOperation[][] {
  if (!replay) return [];
  const canonical = replay.events?.length
    ? replay.events.filter((event) => event.type === "operation").map((event) => event.operation)
    : replay.operations;
  return [
    canonical,
    ...(replay.workflow?.variants ?? []).map((variant) =>
      variant.events?.length
        ? variant.events.filter((event) => event.type === "operation").map((event) => event.operation)
        : variant.operations,
    ),
  ];
}

function applyKnownEdit(current: string, operation: Extract<ReplayOperation, { type: "edit" }>): string | undefined {
  if (!current.includes(operation.oldText)) return undefined;
  if (!operation.replaceAll && current.indexOf(operation.oldText) !== current.lastIndexOf(operation.oldText)) return undefined;
  return operation.replaceAll
    ? current.split(operation.oldText).join(operation.newText)
    : current.replace(operation.oldText, operation.newText);
}

function cloneState(state: Map<string, string>): Map<string, string> {
  return new Map(state);
}

function stepForExercise(content: Content, exerciseId: string): ReplayStep | undefined {
  return content.examples.find((example) => example.id === exerciseId)?.steps.at(-1) as ReplayStep | undefined;
}

function finalStates(
  content: Content,
  step: ReplayStep,
  memo: Map<string, Map<string, string>[]>,
  visiting: Set<string>,
): Map<string, string>[] {
  const cached = memo.get(step.id);
  if (cached) return cached.map(cloneState);
  if (visiting.has(step.id)) return [new Map()];
  visiting.add(step.id);

  const predecessorId = step.replay?.initialState?.fromExercise;
  const predecessor = predecessorId ? stepForExercise(content, predecessorId) : undefined;
  const initial = predecessor ? finalStates(content, predecessor, memo, visiting) : [new Map<string, string>()];
  const sequences = replaySequences(step.replay);
  const output: Map<string, string>[] = [];

  for (const base of initial) {
    for (const sequence of sequences.length > 0 ? sequences : [[]]) {
      const state = cloneState(base);
      for (const operation of sequence) {
        if (operation.type === "write") {
          state.set(operation.path, operation.content);
        } else if (operation.type === "edit") {
          const current = state.get(operation.path);
          if (current === undefined) continue;
          const next = applyKnownEdit(current, operation);
          if (next !== undefined) state.set(operation.path, next);
        }
      }
      output.push(state);
    }
  }

  visiting.delete(step.id);
  memo.set(step.id, output.map(cloneState));
  return output;
}

function buildTransitions(content: Content, step: ReplayStep): Map<string, AuthoredTransition> {
  const transitions = new Map<string, AuthoredTransition>();
  const memo = new Map<string, Map<string, string>[]>();
  const predecessorId = step.replay?.initialState?.fromExercise;
  const predecessor = predecessorId ? stepForExercise(content, predecessorId) : undefined;
  const initial = predecessor ? finalStates(content, predecessor, memo, new Set()) : [new Map<string, string>()];

  for (const base of initial) {
    for (const sequence of replaySequences(step.replay)) {
      const state = cloneState(base);
      const records: Array<{
        key: string;
        path: string;
        before?: string;
        after: string;
        sequenceIndex: number;
      }> = [];

      sequence.forEach((operation, sequenceIndex) => {
        if (operation.type !== "write" && operation.type !== "edit") return;
        const before = state.get(operation.path);
        const after = operation.type === "write"
          ? operation.content
          : before === undefined
            ? undefined
            : applyKnownEdit(before, operation);
        if (after === undefined) return;
        state.set(operation.path, after);
        records.push({ key: operationKey(operation), path: operation.path, before, after, sequenceIndex });
      });

      for (const record of records) {
        const transition = transitions.get(record.key) ?? { before: new Set<string>(), afterOrLater: new Set<string>() };
        if (record.before !== undefined) transition.before.add(record.before);
        transition.afterOrLater.add(record.after);
        for (const later of records) {
          if (later.path === record.path && later.sequenceIndex > record.sequenceIndex) {
            transition.afterOrLater.add(later.after);
          }
        }
        transitions.set(record.key, transition);
      }
    }
  }

  return transitions;
}

function targetInside(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Replay path must be relative: ${path}`);
  const target = resolve(root, path);
  const remainder = relative(resolve(root), target);
  if (remainder === ".." || remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(remainder)) {
    throw new Error(`Replay path escapes the workspace: ${path}`);
  }
  return target;
}

/** Authorizes only exact file states produced by this exercise's authored replay. */
export class ReplayStateGuard {
  private readonly transitions: Map<string, AuthoredTransition>;
  private readonly authoredStates = new Map<string, Set<string>>();

  constructor(content: Content, step: ReplayStep) {
    this.transitions = buildTransitions(content, step);
    const memo = new Map<string, Map<string, string>[]>();
    const visited = new Set<string>();
    let current: ReplayStep | undefined = step;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      for (const state of finalStates(content, current, memo, new Set())) {
        for (const [path, value] of state) {
          const values = this.authoredStates.get(path) ?? new Set<string>();
          values.add(value);
          this.authoredStates.set(path, values);
        }
      }
      const predecessorId: string | undefined = current.replay?.initialState?.fromExercise;
      current = predecessorId ? stepForExercise(content, predecessorId) : undefined;
    }
  }

  decide(operation: Extract<ReplayOperation, { type: "write" | "edit" }>, root: string): ReplayFileDecision {
    const path = targetInside(root, operation.path);
    if (!existsSync(path)) return operation.type === "write" ? { kind: "execute" } : { kind: "reject", path };

    const current = readFileSync(path, "utf8");
    const transition = this.transitions.get(operationKey(operation));
    if (transition?.afterOrLater.has(current)) {
      if (operation.type === "write" && current !== operation.content) return { kind: "execute" };
      return { kind: "already-applied", path };
    }
    if (transition?.before.has(current)) return { kind: "execute" };

    if (!transition && operation.type === "write") {
      if (current === operation.content) return { kind: "already-applied", path };
      return this.authoredStates.get(operation.path)?.has(current)
        ? { kind: "execute" }
        : { kind: "reject", path };
    }
    if (!transition) return { kind: "execute" };
    return { kind: "reject", path };
  }
}
