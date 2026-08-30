import { describe, expect, test } from "bun:test";
import { beginPlanning, type PlanningSession } from "../src/bookmode/planning";
import { resolveContent } from "../src/content";
import type { ReplayStep } from "../src/content/types";

const content = resolveContent().content;
const step = (id: string) =>
  content.steps.find((candidate) => candidate.id === id)! as ReplayStep;
const tools = [
  {
    name: "AskUserQuestion",
    input_schema: { properties: { questions: { type: "array" } } },
  },
];

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
});
