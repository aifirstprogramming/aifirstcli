import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";
import type { ReplayOperation, ReplayStep } from "../src/content/types";
import { ReplayStateGuard } from "../src/learn/replayState";
import { executeReplayOperation } from "../src/replay/executor";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function operations(step: ReplayStep): ReplayOperation[] {
  return step.replay?.events?.filter((event) => event.type === "operation").map((event) => event.operation)
    ?? step.replay?.operations
    ?? [];
}

describe("authored replay file states", () => {
  test("safely replays a completed Duckling project through its authored states", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-state-"));
    const content = resolveContent().content;
    const step = content.steps.find((candidate) => candidate.id === "py-9-01") as ReplayStep;
    const sourceOperations = operations(step).filter((operation) => operation.type === "write" || operation.type === "edit");
    for (const operation of sourceOperations) expect(executeReplayOperation(operation, root).ok).toBe(true);

    const guard = new ReplayStateGuard(content, step);
    for (const operation of sourceOperations) {
      const decision = guard.decide(operation, root);
      expect(decision.kind, `${operation.type} ${operation.path}`).not.toBe("reject");
      if (decision.kind === "execute") expect(executeReplayOperation(operation, root).ok).toBe(true);
    }
  });

  test("continues safely from an authored intermediate state", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-partial-"));
    const content = resolveContent().content;
    const step = content.steps.find((candidate) => candidate.id === "py-9-01") as ReplayStep;
    const sourceOperations = operations(step).filter((operation) => operation.type === "write" || operation.type === "edit");
    const firstEdit = sourceOperations.findIndex((operation) => operation.type === "edit");
    for (const operation of sourceOperations.slice(0, firstEdit)) executeReplayOperation(operation, root);

    const guard = new ReplayStateGuard(content, step);
    for (const operation of sourceOperations.slice(0, firstEdit)) {
      expect(guard.decide(operation, root).kind).toBe("already-applied");
    }
    expect(guard.decide(sourceOperations[firstEdit]!, root).kind).toBe("execute");
  });

  test("still rejects a learner-modified replay file", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-modified-"));
    const content = resolveContent().content;
    const step = content.steps.find((candidate) => candidate.id === "py-9-01") as ReplayStep;
    const sourceOperations = operations(step).filter((operation) => operation.type === "write" || operation.type === "edit");
    for (const operation of sourceOperations) executeReplayOperation(operation, root);
    appendFileSync(join(root, "level.py"), "\n# learner change\n");

    const levelWrite = sourceOperations.find((operation) => operation.type === "write" && operation.path === "level.py")!;
    expect(new ReplayStateGuard(content, step).decide(levelWrite, root).kind).toBe("reject");
  });
});
