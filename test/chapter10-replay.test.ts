import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginPlanning, type PlanningSession } from "../src/bookmode/planning";
import { respond } from "../src/bookmode/responder";
import { resolveContent } from "../src/content";
import type { ReplayStep } from "../src/content/types";
import { emptyLog } from "../src/log/progress";
import { seedScaffold } from "./helpers/scaffold";

const content = resolveContent().content;
const step = (id: string) =>
  content.steps.find((candidate) => candidate.id === id)! as ReplayStep;
const tools = [
  {
    name: "AskUserQuestion",
    input_schema: { properties: { questions: { type: "array" } } },
  },
  {
    name: "Read",
    input_schema: { properties: { file_path: { type: "string" } } },
  },
  {
    name: "Write",
    input_schema: {
      properties: { file_path: { type: "string" }, content: { type: "string" } },
    },
  },
  {
    name: "Edit",
    input_schema: {
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
    },
  },
  {
    name: "Bash",
    input_schema: { properties: { command: { type: "string" } } },
  },
];

function seed(workspace: string, stepId: string): void {
  seedScaffold(workspace, step(stepId), content);
}

describe("chapter 10 level-editor replays", () => {
  test("publishes the authoritative four-step progression", () => {
    const chapter = content.books
      .find((book) => book.tag === "py")!
      .sections.flatMap((section) => section.chapters)
      .find((candidate) => candidate.number === 10)!;
    expect(chapter.examples.map((example) => example.id)).toEqual([
      "py-10-01",
      "py-10-02",
      "py-10-03",
      "py-10-04",
    ]);
  });

  test("labels the captured level-editor and pathfinder answers", () => {
    const editor = step("py-10-01").replay!.workflow!;
    expect(editor.canonicalAnswers).toEqual({
      level_format: "json_files",
      editor_ui: "standalone_script",
      feature_scope: "core_grid_placement",
    });
    expect(editor.questions.every((question) => question.group === "group_1")).toBe(
      true,
    );

    const pathfinder = step("py-10-04").replay!.workflow!;
    expect(pathfinder.canonicalAnswers).toEqual({
      fox_handling: "ignore_foxes_check_static_connectivity",
      animation_style: "frontier_expansion_final_path",
    });
  });

  test("keeps the Copilot checkpoint as an explicit two-file reconstruction", () => {
    const replay = step("py-10-02").replay!;
    expect(replay.workflow).toBeUndefined();
    expect(
      replay.events?.filter(
        (event) => event.type === "operation" && event.operation.type === "edit",
      ),
    ).toHaveLength(2);
    expect(replay.source?.sessionId).toContain("legacy-");
  });

  test("shows questionless Claude plan mode before undo implementation", () => {
    const undo = step("py-10-03");
    const planning: PlanningSession = { answers: {} };
    const outcome = beginPlanning(undo, planning, tools);
    expect(outcome.kind).toBe("reply");
    if (outcome.kind !== "reply") return;
    expect(outcome.reply.text).toContain("## Proposed plan");
    expect(outcome.reply.text).toContain("Undo/Redo for the Level Editor");
    expect(outcome.reply.toolUse?.name).toBe("AskUserQuestion");
    expect(JSON.stringify(outcome.reply.toolUse?.input)).toContain(
      "Approve and build",
    );
  });

  test("starts py-10-01 independently without reading missing chapter 9 files", () => {
    const workspace = mkdtempSync(join(tmpdir(), "aifirst-editor-standalone-"));
    const original = process.cwd();
    process.chdir(workspace);
    try {
      const planning: PlanningSession = { answers: {} };
      const reply = respond(
        {
          messages: [{ role: "user", content: "Design a level editor for the savetheduckling game." }],
          tools,
        },
        content,
        emptyLog(),
        { planning },
      );
      expect(reply.toolUse?.name).toBe("AskUserQuestion");
      expect(reply.toolUse?.name).not.toBe("Read");
      expect(reply.text).toContain("self-contained build path");
      expect(planning.replayMode).toBe("standalone");

      const approval = respond(
        {
          messages: [{
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: reply.toolUse?.id,
              content: JSON.stringify({ answers: {
                level_format: "JSON files (Book Recommended)",
                editor_ui: "Standalone script (Book Recommended)",
                feature_scope: "Core grid placement (Book Recommended)",
              } }),
            }],
          }],
          tools,
        },
        content,
        emptyLog(),
        { planning },
      );
      expect(approval.text).toContain("## Proposed plan");
      expect(existsSync(join(workspace, "assets"))).toBe(false);

      const build = respond(
        {
          messages: [{
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: approval.toolUse?.id,
              content: '{"answers":{"Plan":"Approve and build"}}',
            }],
          }],
          tools,
        },
        content,
        emptyLog(),
        { planning },
      );
      expect(build.toolUse?.name).toBe("Write");
      expect(build.toolUse?.id).toBe("aifirst_replay_standalone_py-10-01_0");
      expect(readFileSync(join(workspace, "assets", "fox.png")).subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    } finally {
      process.chdir(original);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("keeps the captured py-10-01 preflight when chapter 9 state is present", () => {
    const workspace = mkdtempSync(join(tmpdir(), "aifirst-editor-captured-"));
    const original = process.cwd();
    seed(workspace, "py-9-03");
    process.chdir(workspace);
    try {
      const planning: PlanningSession = { answers: {} };
      const reply = respond(
        {
          messages: [{ role: "user", content: "Design a level editor for the savetheduckling game." }],
          tools,
        },
        content,
        emptyLog(),
        { planning },
      );
      expect(reply.toolUse?.name).toBe("Read");
      expect(reply.toolUse?.id).toBe("aifirst_preplan_py-10-01_0");
      expect(planning.replayMode).toBe("captured");
    } finally {
      process.chdir(original);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("uses full-file operations for a later exercise in an empty workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "aifirst-leveldef-standalone-"));
    const original = process.cwd();
    process.chdir(workspace);
    try {
      const reply = respond(
        {
          messages: [{ role: "user", content: "wouldn't it be cleaner to also have a matching save_level_def in the LevelDef class?" }],
          tools,
        },
        content,
        emptyLog(),
      );
      expect(reply.toolUse?.name).toBe("Write");
      expect(reply.toolUse?.id).toBe("aifirst_replay_standalone_py-10-02_0");

      const next = respond(
        {
          messages: [{
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: reply.toolUse?.id,
              content: "File written successfully",
            }],
          }],
          tools,
        },
        content,
        emptyLog(),
      );
      expect(next.toolUse?.name).toBe("Write");
      expect(next.toolUse?.id).toBe("aifirst_replay_standalone_py-10-02_1");
    } finally {
      process.chdir(original);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
