import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";
import { writeScaffold } from "../src/content/scaffold";
import type { ReplayEvent, ReplayStep } from "../src/content/types";
import { nativeReplayOperation, replayOperationFailed } from "../src/learn/native";
import { ReplayStateGuard } from "../src/learn/replayState";
import { executeReplayOperationAsync } from "../src/replay/executor";

const suite = process.env.AIFIRST_DUCKLING_PORTABLE === "1" ? describe : describe.skip;
let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

suite("portable Save the Duckling replay", () => {
  test("executes the complete captured timeline without external bash", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-duckling-portable-"));
    const { content } = resolveContent();
    const step = content.steps.find((candidate) => candidate.id === "py-9-01") as ReplayStep;
    writeScaffold(root, step, content, { binaryOnly: true });
    const guard = new ReplayStateGuard(content, step);
    const events: ReplayEvent[] = [
      ...(step.replay?.prePlanEvents ?? []),
      ...(step.replay?.workflow?.interludes ?? []).flatMap((interlude) => interlude.events),
      ...(step.replay?.events ?? []),
    ];

    for (const event of events) {
      if (event.type !== "operation") continue;
      const operation = event.operation;
      if (operation.type === "write" || operation.type === "edit") {
        const decision = guard.decide(operation, root);
        expect(decision.kind, `${operation.type} ${operation.path}`).not.toBe("reject");
        if (decision.kind === "already-applied") continue;
      }
      const materialized = nativeReplayOperation(operation, step);
      const result = await executeReplayOperationAsync(materialized, root);
      expect(replayOperationFailed(operation, result), result.text).toBe(false);
      if (operation.type === "command" && operation.portableCommand) {
        expect(result.command?.command[0]).not.toBe("bash");
      }
    }

    for (const path of ["main.py", "constants.py", "assets_gen.py", "entities.py", "level.py"]) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
  }, 60_000);
});
