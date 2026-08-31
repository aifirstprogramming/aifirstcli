/** Real-client acceptance for the retrofitted chapter 10 level-editor sequence. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";
import type { ReplayStep } from "../src/content/types";
import { expectScaffold, seedScaffold } from "./helpers/scaffold";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const claude = Bun.which("claude");
const pythonReady =
  Bun.spawnSync({
    cmd: ["python3", "-c", "import PIL, pygame"],
    env: { ...process.env, PYGAME_HIDE_SUPPORT_PROMPT: "1" },
  }).exitCode === 0;
const liveEnabled = process.env.AIFIRST_CLAUDE_LIVE === "1";
const describeLive = liveEnabled && claude && pythonReady ? describe : describe.skip;
const content = resolveContent().content;

interface StreamBlock {
  type?: string;
  text?: string;
  name?: string;
}

interface StreamEvent {
  type?: string;
  message?: { content?: StreamBlock[] };
}

function replayStep(id: string): ReplayStep {
  return content.steps.find(
    (candidate) => candidate.id === id,
  )! as ReplayStep;
}

function seedWorkspace(workspace: string, stepId: string): void {
  seedScaffold(workspace, replayStep(stepId), content);
  const generated = Bun.spawnSync({
    cmd: ["python3", "assets_gen.py"],
    cwd: workspace,
    env: { ...process.env, PYGAME_HIDE_SUPPORT_PROMPT: "1" },
  });
  expect(generated.exitCode, generated.stderr.toString()).toBe(0);
}

function referenceOutputs(stepId: string): string[] {
  const contentRoot =
    process.env.AIFIRST_CONTENT_REPO ??
    join(import.meta.dir, "..", "..", "aifirstcontent");
  const report = JSON.parse(
    readFileSync(
      join(
        contentRoot,
        "replays",
        "python",
        "chapter-10",
        stepId,
        "bundle",
        "report.json",
      ),
      "utf8",
    ),
  ) as { turns: Array<{ aiOutputs?: Array<{ text: string }> }> };
  return (report.turns[0]?.aiOutputs ?? []).map((output) => output.text);
}

function assistantBlocks(stdout: string): string[] {
  const blocks: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as StreamEvent;
      if (event.type !== "assistant") continue;
      for (const block of event.message?.content ?? [])
        if (block.type === "text" && block.text)
          blocks.push(block.text.replace(/\r\n/g, "\n"));
    } catch {
      // Ignore non-stream diagnostics.
    }
  }
  return blocks;
}

function expectCapturedText(stdout: string, stepId: string): void {
  const actual = assistantBlocks(stdout);
  let blockIndex = 0;
  let blockOffset = 0;
  for (const output of referenceOutputs(stepId)) {
    const expected = output.replace(/\r\n/g, "\n");
    let foundBlock = -1;
    let foundOffset = -1;
    for (let index = blockIndex; index < actual.length; index++) {
      const offset = actual[index].indexOf(
        expected,
        index === blockIndex ? blockOffset : 0,
      );
      if (offset < 0) continue;
      foundBlock = index;
      foundOffset = offset;
      break;
    }
    expect(
      foundBlock,
      `Missing exact ${stepId} assistant text: ${expected.slice(0, 120)}`,
    ).toBeGreaterThanOrEqual(0);
    blockIndex = foundBlock;
    blockOffset = foundOffset + expected.length;
  }
}

function operationCounts(stepId: string): Record<string, number> {
  const replay = replayStep(stepId).replay!;
  const events = [
    ...(replay.prePlanEvents ?? []),
    ...(replay.workflow?.interludes ?? []).flatMap((item) => item.events),
    ...(replay.events ?? []),
  ];
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "operation") continue;
    counts[event.operation.type] = (counts[event.operation.type] ?? 0) + 1;
  }
  return counts;
}

function actualOperationCounts(stdout: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as StreamEvent;
      if (event.type !== "assistant") continue;
      for (const block of event.message?.content ?? []) {
        if (block.type !== "tool_use" || !block.name) continue;
        const type = ({
          bash: "command",
          write: "write",
          edit: "edit",
          read: "read",
        } as Record<string, string>)[block.name.toLowerCase()];
        if (type) counts[type] = (counts[type] ?? 0) + 1;
      }
    } catch {
      // Ignore non-stream diagnostics.
    }
  }
  return counts;
}

function expectOperations(stdout: string, stepId: string): void {
  expect(actualOperationCounts(stdout)).toEqual(operationCounts(stepId));
}

describeLive("chapter 10 level-editor replay through aifirst learn", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function run(
    mode: "editor" | "leveldef" | "undo" | "pathfinder",
    stepId: string,
    seedId: string,
  ): Promise<void> {
    root = mkdtempSync(join(tmpdir(), `aifirst-${mode}-live-`));
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    mkdirSync(workspace, { recursive: true });
    seedWorkspace(workspace, seedId);
    const driver = join(
      import.meta.dir,
      "fixtures",
      "chapter10-stream-driver.py",
    );
    const proc = Bun.spawn(
      ["python3", driver, process.execPath, ENTRY, workspace, mode],
      {
        cwd: workspace,
        env: {
          ...process.env,
          AIFIRST_STATE_DIR: state,
          AIFIRST_LEARN_CHARS_PER_SECOND: "100000",
          PYGAME_HIDE_SUPPORT_PROMPT: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
    expectCapturedText(stdout, stepId);
    expectOperations(stdout, stepId);
    expectScaffold(workspace, replayStep(stepId), content);
    expect(existsSync(join(workspace, "levels", "level_4.json"))).toBe(false);
  }

  test("designs the JSON-backed standalone editor", async () => {
    await run("editor", "py-10-01", "py-9-03");
  }, 90_000);

  test("replays the provenance-marked Copilot LevelDef refactor", async () => {
    await run("leveldef", "py-10-02", "py-10-01");
  }, 90_000);

  test("shows and approves the questionless undo plan", async () => {
    await run("undo", "py-10-03", "py-10-02");
  }, 90_000);

  test("builds and verifies the animated BFS pathfinder", async () => {
    await run("pathfinder", "py-10-04", "py-10-03");
  }, 90_000);
});
