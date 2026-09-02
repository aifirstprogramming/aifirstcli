import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import type { PlanningSession } from "../src/bookmode/planning";
import { respond, type Reply } from "../src/bookmode/responder";
import { resolveContent } from "../src/content";
import { scaffoldFileData } from "../src/content/scaffold";
import type { ReplayOperation, ReplayStep } from "../src/content/types";
import { emptyLog } from "../src/log/progress";
import { resolveReplay } from "../src/replay/resolver";
import { seedScaffold } from "./helpers/scaffold";

const { content } = resolveContent();
const replaySteps = (content.steps as ReplayStep[]).filter((step) => step.replay);
const progressive = replaySteps.filter((step) => step.replay?.initialState);
const TOOLS = [
  { name: "AskUserQuestion", input_schema: { properties: { questions: { type: "array" } } } },
  { name: "Read", input_schema: { properties: { file_path: { type: "string" } } } },
  { name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } } } },
  { name: "Edit", input_schema: { properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } } } },
  { name: "Bash", input_schema: { properties: { command: { type: "string" } } } },
];

function operationPath(operation: ReplayOperation): string | undefined {
  return operation.type === "write" || operation.type === "edit" || operation.type === "read"
    ? operation.path
    : operation.cwd;
}

function safePath(path: string): boolean {
  return !isAbsolute(path) && !path.split(/[\\/]+/).includes("..");
}

function recommendedAnswer(reply: Reply): string {
  const questions = reply.toolUse?.input.questions;
  if (!Array.isArray(questions)) throw new Error(`No questions in ${reply.toolUse?.id}`);
  const answers: Record<string, string> = {};
  for (const rawQuestion of questions) {
    const question = rawQuestion as { question?: string; header?: string; options?: Array<{ label?: string }> };
    const option = question.options?.find((candidate) => /Book Recommended|Approve and build/i.test(candidate.label ?? ""));
    if (!option?.label) throw new Error(`No recommended option for ${question.question ?? question.header}`);
    answers[question.question ?? question.header ?? "Question"] = option.label;
  }
  return JSON.stringify({ answers });
}

function startStandalone(step: ReplayStep, planning: PlanningSession): Reply {
  let reply = respond(
    { messages: [{ role: "user", content: step.replay?.prompt ?? step.prompt }], tools: TOOLS },
    content,
    emptyLog(),
    { planning },
  );
  for (let turns = 0; turns < 20 && !reply.toolUse?.id?.startsWith("aifirst_replay_standalone_"); turns++) {
    expect(reply.toolUse?.name, `${step.id} stopped before standalone replay`).toBe("AskUserQuestion");
    reply = respond({
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: reply.toolUse?.id,
        content: recommendedAnswer(reply),
      }] }],
      tools: TOOLS,
    }, content, emptyLog(), { planning });
  }
  return reply;
}

describe("replay independence contracts", () => {
  test("every replay has one exact prompt and safe, resolvable dependencies", () => {
    expect(replaySteps.length).toBeGreaterThan(0);
    const ids = new Set(content.steps.map((step) => step.id));
    for (const step of replaySteps) {
      const match = resolveReplay(step.replay?.prompt ?? step.prompt, content, step.language);
      expect(match.kind, step.id).toBe("exact");
      if (match.kind === "exact") expect(match.step.id).toBe(step.id);

      const dependency = step.replay?.initialState?.fromExercise;
      if (dependency) expect(ids.has(dependency), `${step.id} -> ${dependency}`).toBe(true);
      const scaffoldPaths = new Set<string>();
      for (const file of step.scaffold?.files ?? []) {
        expect(safePath(file.path), `${step.id}: ${file.path}`).toBe(true);
        expect(scaffoldPaths.has(file.path), `${step.id}: duplicate ${file.path}`).toBe(false);
        scaffoldPaths.add(file.path);
        if (file.fromExercise) expect(ids.has(file.fromExercise), `${step.id}: ${file.fromExercise}`).toBe(true);
        expect(scaffoldFileData(file, content), `${step.id}: unresolved ${file.path}`).toBeDefined();
      }
      const eventOperations = [
        ...(step.replay?.prePlanEvents ?? []),
        ...(step.replay?.events ?? []),
        ...(step.replay?.workflow?.interludes ?? []).flatMap((interlude) => interlude.events),
      ].flatMap((event) => event.type === "operation" ? [event.operation] : []);
      for (const operation of [...(step.replay?.operations ?? []), ...eventOperations]) {
        const path = operationPath(operation);
        if (path) expect(safePath(path), `${step.id}: unsafe operation path ${path}`).toBe(true);
      }
    }
  });

  test("progressive replay dependencies are acyclic", () => {
    const dependency = new Map(progressive.map((step) => [step.id, step.replay!.initialState!.fromExercise]));
    for (const start of dependency.keys()) {
      const seen = new Set<string>();
      let current: string | undefined = start;
      while (current && dependency.has(current)) {
        expect(seen.has(current), `dependency cycle from ${start}`).toBe(false);
        seen.add(current);
        current = dependency.get(current);
      }
    }
  });

  test("all progressive replays choose a complete standalone path in an empty workspace", () => {
    for (const step of progressive) {
      const root = mkdtempSync(join(tmpdir(), `aifirst-independent-${step.id}-`));
      const originalCwd = process.cwd();
      process.chdir(root);
      try {
        const operations = step.replay!.operations;
        expect(operations.some((operation) => operation.type === "read" || operation.type === "edit"), step.id).toBe(false);
        const firstCommand = operations.findIndex((operation) => operation.type === "command");
        if (firstCommand >= 0) {
          expect(operations.slice(0, firstCommand).every((operation) => operation.type === "write"), step.id).toBe(true);
          expect(operations.slice(firstCommand).some((operation) => operation.type === "write"), step.id).toBe(false);
        }

        const planning: PlanningSession = { answers: {} };
        const reply = startStandalone(step, planning);
        expect(reply.toolUse?.id, step.id).toBe(`aifirst_replay_standalone_${step.id}_0`);
        expect(reply.toolUse?.name, step.id).toBe("Write");
        if (step.replay?.workflow) expect(planning.replayMode, step.id).toBe("standalone");
      } finally {
        process.chdir(originalCwd);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("predecessor scaffolds preserve each captured replay path", () => {
    for (const step of progressive) {
      const root = mkdtempSync(join(tmpdir(), `aifirst-captured-${step.id}-`));
      const originalCwd = process.cwd();
      const predecessor = content.steps.find((candidate) => candidate.id === step.replay!.initialState!.fromExercise)!;
      mkdirSync(root, { recursive: true });
      seedScaffold(root, predecessor, content);
      process.chdir(root);
      try {
        const planning: PlanningSession = { answers: {} };
        const reply = respond(
          { messages: [{ role: "user", content: step.replay?.prompt ?? step.prompt }], tools: TOOLS },
          content,
          emptyLog(),
          { planning },
        );
        expect(reply.toolUse?.id, step.id).not.toContain("standalone");
        expect(reply.text, step.id).not.toContain("self-contained build path");
        if (step.replay?.workflow) expect(planning.replayMode, step.id).toBe("captured");
      } finally {
        process.chdir(originalCwd);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
