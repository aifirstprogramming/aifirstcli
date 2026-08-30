import { describe, expect, test } from "bun:test";
import {
  beginPlanning,
  continuePlanning,
  finishPlanningInterlude,
  planningToolResult,
  type PlanningSession,
} from "../src/bookmode/planning";
import { respond } from "../src/bookmode/responder";
import { resolveContent } from "../src/content";
import type { ReplayStep } from "../src/content/types";
import { emptyLog } from "../src/log/progress";

const content = resolveContent().content;
const duckling = content.steps.find((step) => step.id === "py-9-01")! as ReplayStep;
const TOOLS = [
  { name: "AskUserQuestion", input_schema: { properties: { questions: { type: "array" } } } },
  { name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } } } },
  { name: "Bash", input_schema: { properties: { command: { type: "string" } } } },
];

function state(): PlanningSession {
  return { answers: {} };
}

function reply(outcome: ReturnType<typeof beginPlanning>) {
  expect(outcome.kind).toBe("reply");
  if (outcome.kind !== "reply") throw new Error("expected planning reply");
  return outcome.reply;
}

describe("model-free planning workflow", () => {
  test("groups captured questions and labels the book answer", () => {
    const planning = state();
    const first = reply(beginPlanning(duckling, planning, TOOLS));
    expect(first.toolUse?.name).toBe("AskUserQuestion");
    expect(first.text).toBe("");
    expect(JSON.stringify(first.toolUse?.input)).toContain("Top-down maze/exploration (Book Recommended)");
    expect(JSON.stringify(first.toolUse?.input)).toContain("What should make the search challenging");
    expect(JSON.stringify(first.toolUse?.input)).toContain("What visual style");
    expect(first.toolUse?.name).not.toBe("Write");

    const assets = reply(continuePlanning(duckling, planning, TOOLS, JSON.stringify({ answers: {
      game_style: "Top-down maze/exploration (Book Recommended)",
      challenge: "Collect siblings (Book Recommended)",
      art_style: "Simple sprite images (Book Recommended)",
    } })));
    expect(assets.text).toBe("");
    expect(JSON.stringify(assets.toolUse?.input)).toContain("How should the duckling/mother/sibling/background sprites be sourced");

    const interlude = continuePlanning(duckling, planning, TOOLS, "Generate simple PNG sprites programmatically (Book Recommended)");
    expect(interlude.kind).toBe("interlude");
    if (interlude.kind !== "interlude") throw new Error("expected planning interlude");
    expect(interlude.events.some((event) => event.type === "operation" && event.operation.type === "command")).toBe(true);
    const approval = reply(finishPlanningInterlude(duckling, planning, TOOLS, "sprite_source"));
    expect(approval.text).toContain("## Proposed plan");
    expect(approval.text).toContain("No files have been changed yet.");
    expect(approval.toolUse?.name).toBe("AskUserQuestion");
    expect(JSON.stringify(approval.toolUse?.input)).toContain("Approve and build");

    const run = continuePlanning(duckling, planning, TOOLS, "Approve and build");
    expect(run.kind).toBe("run");
    if (run.kind === "run") {
      expect(run.active.kind).toBe("canonical");
      expect(run.active.replay.operations).toHaveLength(duckling.replay!.operations.length);
    }
  });

  test("guides an unsupported choice back to the book path", () => {
    const planning = state();
    beginPlanning(duckling, planning, TOOLS);
    const fallback = reply(continuePlanning(duckling, planning, TOOLS, "Side-scrolling platformer"));
    expect(fallback.text).toContain("needs an LLM");
    expect(JSON.stringify(fallback.toolUse?.input)).toContain("Use book-recommended answer");

    const resumed = reply(continuePlanning(duckling, planning, TOOLS, "Use book-recommended answer"));
    expect(planning.answers.game_style).toBe("top_down_maze_exploration");
    expect(JSON.stringify(resumed.toolUse?.input)).toContain("What should make the search challenging");
  });

  test("can restart or exit without producing replay operations", () => {
    const planning = state();
    beginPlanning(duckling, planning, TOOLS);
    continuePlanning(duckling, planning, TOOLS, "Multi-level progression");
    const restarted = reply(continuePlanning(duckling, planning, TOOLS, "Restart planning"));
    expect(planning.answers).toEqual({});
    expect(JSON.stringify(restarted.toolUse?.input)).toContain("What style of gameplay");

    continuePlanning(duckling, planning, TOOLS, "Side-scrolling platformer");
    const exited = reply(continuePlanning(duckling, planning, TOOLS, "Exit local learning"));
    expect(exited.text).toContain("normal Claude Code");
    expect(planning.stepId).toBeUndefined();
  });

  test("selects an explicitly authored deterministic variant", () => {
    const candidate = structuredClone(duckling);
    candidate.replay!.workflow!.variants = [{
      id: "side_scroller",
      answers: {
        game_style: "side_scrolling_platformer",
        challenge: "collect_siblings",
        art_style: "simple_sprite_images",
      },
      plan: "Build the authored side-scrolling version.",
      operations: [{ type: "write", path: "variant.txt", content: "side scroller\n" }],
    }];
    const planning = state();
    beginPlanning(candidate, planning, TOOLS);
    continuePlanning(candidate, planning, TOOLS, "Side-scrolling platformer");
    continuePlanning(candidate, planning, TOOLS, "Collect siblings (Book Recommended)");
    const approval = continuePlanning(candidate, planning, TOOLS, "Simple sprite images (Book Recommended)");
    expect(approval.kind === "reply" ? approval.reply.text : "").toContain("authored side-scrolling version");
    const run = continuePlanning(candidate, planning, TOOLS, "Approve and build");
    expect(run.kind).toBe("run");
    if (run.kind === "run") {
      expect(run.active.kind).toBe("authored");
      expect(run.active.variantId).toBe("side_scroller");
      expect(run.active.replay.operations[0]).toEqual({ type: "write", path: "variant.txt", content: "side scroller\n" });
    }
  });

  test("parses native AskUserQuestion tool results", () => {
    expect(planningToolResult([{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: "aifirst_plan_py-9-01_question_gameplay",
      content: '{"answers":{"Gameplay":"Top-down maze/exploration (Book Recommended)"}}',
    }] }])).toBe("Top-down maze/exploration (Book Recommended)");
    expect(planningToolResult([{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: "aifirst_plan_py-9-01_question_gameplay",
      content: 'Your questions have been answered: "What style?"="Top-down maze/exploration (Book Recommended)".',
    }] }])).toBe("Top-down maze/exploration (Book Recommended)");
    expect(planningToolResult([{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: "aifirst_plan_py-9-01_question_gameplay+challenge+visual_style",
      content: "User answered Claude's questions:\n· What style? → Top-down\n· What challenge? → Collect siblings\n· What visuals? → Simple sprites",
    }] }])).toEqual({
      "What style?": "Top-down",
      "What challenge?": "Collect siblings",
      "What visuals?": "Simple sprites",
    });
    expect(planningToolResult([{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: "aifirst_plan_py-9-01_question_gameplay+challenge+visual_style",
      content: 'User has answered: "Gameplay"="Top-down", "Challenge"="Collect siblings", "Visuals"="Simple sprites".',
    }] }])).toEqual({
      Gameplay: "Top-down",
      Challenge: "Collect siblings",
      Visuals: "Simple sprites",
    });
  });
});

describe("responder planning integration", () => {
  test("preserves a text-only pre-plan preamble before the first question", () => {
    const candidateContent = structuredClone(content);
    const candidate = candidateContent.steps.find(
      (step) => step.id === "py-9-01",
    )! as ReplayStep;
    candidate.replay!.prePlanEvents = [
      { type: "text", text: "I will clarify the design before planning." },
    ];
    const planning = state();
    const result = respond(
      { messages: [{ role: "user", content: candidate.prompt }], tools: TOOLS },
      candidateContent,
      emptyLog(),
      { planning },
    );
    expect(result.text).toBe("I will clarify the design before planning.");
    expect(result.toolUse?.id).toContain("question_game_style+challenge+art_style");
  });

  test("an exact workflow prompt runs captured read-only preflight before planning", () => {
    const planning = state();
    const first = respond({ messages: [{ role: "user", content: duckling.prompt }], tools: TOOLS }, content, emptyLog(), { planning });
    expect(first.toolUse?.name).toBe("Bash");
    expect(first.toolUse?.id).toBe("aifirst_preplan_py-9-01_0");
    const second = respond({ messages: [{ role: "user", content: [{
      type: "tool_result", tool_use_id: "aifirst_preplan_py-9-01_0", content: "empty", is_error: false,
    }] }], tools: TOOLS }, content, emptyLog(), { planning });
    expect(second.toolUse?.id).toBe("aifirst_preplan_py-9-01_1");
    const result = respond({ messages: [{ role: "user", content: [{
      type: "tool_result", tool_use_id: "aifirst_preplan_py-9-01_1", content: "Python 3.11.9", is_error: false,
    }] }], tools: TOOLS }, content, emptyLog(), { planning });
    expect(result.toolUse?.name).toBe("AskUserQuestion");
    expect(result.toolUse?.id).toContain("question_game_style+challenge+art_style");
    expect(planning.stepId).toBe("py-9-01");
  });

  test("a partial duckling prompt confirms before planning", () => {
    const planning = state();
    const confirmation: { stepId?: string } = {};
    const first = respond({ messages: [{ role: "user", content: "baby duckling who is trying to find its mother" }], tools: TOOLS }, content, emptyLog(), { planning, confirmation });
    expect(first.toolUse?.name).toBe("AskUserQuestion");
    expect(first.toolUse?.id).toBe("aifirst_confirm_py-9-01");
    expect(planning.stepId).toBeUndefined();

    const second = respond({
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: "aifirst_confirm_py-9-01",
        content: '{"answers":{"AI First":"Run this replay"}}',
      }] }],
      tools: TOOLS,
    }, content, emptyLog(), { planning, confirmation });
    expect(second.toolUse?.id).toBe("aifirst_preplan_py-9-01_0");
    expect(planning.stepId).toBeUndefined();
  });

  test("session-title requests do not start or reset planning", () => {
    const planning = state();
    const result = respond({
      messages: [{
        role: "user",
        content: `<session>\n${duckling.prompt}\n</session>\n\nWrite the title in the predominant language of the session.`,
      }],
      tools: TOOLS,
    }, content, emptyLog(), { planning });
    expect(result.text).toBe("Save the Duckling");
    expect(result.stopReason).toBe("end_turn");
    expect(planning.stepId).toBeUndefined();
  });
});
