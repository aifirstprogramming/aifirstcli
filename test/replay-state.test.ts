import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";
import type { ReplayOperation, ReplayStep } from "../src/content/types";
import { ReplayStateGuard } from "../src/learn/replayState";
import { executeReplayOperation } from "../src/replay/executor";
import { seedScaffold } from "./helpers/scaffold";

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

  test("allows a standalone exercise to replace an older exact book checkpoint", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-older-checkpoint-"));
    const content = resolveContent().content;
    const earlier = content.steps.find((candidate) => candidate.id === "py-9-03") as ReplayStep;
    const target = content.steps.find((candidate) => candidate.id === "py-10-02") as ReplayStep;
    seedScaffold(root, earlier, content);

    const guard = new ReplayStateGuard(content, target);
    for (const operation of target.replay!.operations) {
      if (operation.type !== "write" && operation.type !== "edit") continue;
      const decision = guard.decide(operation, root);
      expect(decision.kind, operation.type + " " + operation.path).not.toBe("reject");
      if (decision.kind === "execute") expect(executeReplayOperation(operation, root).ok).toBe(true);
    }
  });

  test("still protects a learner modification to an older book checkpoint", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-older-modified-"));
    const content = resolveContent().content;
    const earlier = content.steps.find((candidate) => candidate.id === "py-9-03") as ReplayStep;
    const target = content.steps.find((candidate) => candidate.id === "py-10-02") as ReplayStep;
    seedScaffold(root, earlier, content);
    appendFileSync(join(root, "assets_gen.py"), "\n# learner change\n");

    const assetsWrite = target.replay!.operations.find(
      (operation): operation is Extract<ReplayOperation, { type: "write" }> =>
        operation.type === "write" && operation.path === "assets_gen.py",
    )!;
    expect(new ReplayStateGuard(content, target).decide(assetsWrite, root).kind).toBe("reject");
  });
});
