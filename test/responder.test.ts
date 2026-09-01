import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carriesToolResult, readerText, respond, shellTool } from "../src/bookmode/responder";
import { resolveContent } from "../src/content";
import type { ReplayStep } from "../src/content/types";
import { emptyLog } from "../src/log/progress";

/**
 * Book mode's whole behaviour, decided without a socket.
 *
 * The point of the feature is that a book exercise needs no model at request time,
 * because the answer was computed and committed at authoring time. These tests are
 * where that claim is actually checked.
 */

const { content } = resolveContent();
const log = emptyLog();

/** The shape Claude Code sends: a shell tool among many others. */
const TOOLS = [
  { name: "Read", input_schema: { properties: { file_path: { type: "string" } } } },
  { name: "Bash", input_schema: { properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Write", input_schema: { properties: { content: { type: "string" } } } },
];
const NATIVE_TOOLS = [
  { name: "Bash", input_schema: { properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Edit", input_schema: { properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } } } },
  { name: "Read", input_schema: { properties: { file_path: { type: "string" } } } },
  { name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
];
const NATIVE_TOOLS_WITH_QUESTION = [
  ...NATIVE_TOOLS,
  { name: "AskUserQuestion", input_schema: { properties: { questions: { type: "array" } }, required: ["questions"] } },
];

const userTurn = (text: string) => ({ messages: [{ role: "user", content: text }], tools: TOOLS });

describe("shellTool discovery", () => {
  it("finds the tool that takes a command, whatever it is called", () => {
    expect(shellTool(TOOLS)).toBe("Bash");
    expect(shellTool([{ name: "RunShell", input_schema: { properties: { command: { type: "string" } } } }])).toBe(
      "RunShell",
    );
  });

  it("returns nothing when no tool can run a command", () => {
    expect(shellTool([{ name: "Read", input_schema: { properties: { file_path: { type: "string" } } } }])).toBeUndefined();
    expect(shellTool(undefined)).toBeUndefined();
  });
});

describe("reading what the reader typed", () => {
  it("ignores context the client injects around it", () => {
    const text = readerText([
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>You are in a git repo</system-reminder>" },
          { type: "text", text: "Write a Hello World app" },
        ],
      },
    ]);
    expect(text).toBe("Write a Hello World app");
  });

  it("takes the most recent user turn, not the first", () => {
    expect(
      readerText([
        { role: "user", content: "Write a Hello World app" },
        { role: "assistant", content: "..." },
        { role: "user", content: "Ask for a pet's type and name" },
      ]),
    ).toBe("Ask for a pet's type and name");
  });

  it("extracts the reader prompt from Claude's session title request", () => {
    expect(
      readerText([
        {
          role: "user",
          content:
            "<session>\nWrite Hello World app\n</session>\n\nWrite the title in the predominant language of the session.",
        },
      ]),
    ).toBe("Write Hello World app");
  });

  it("skips tool results, which are not something the reader typed", () => {
    const messages = [
      { role: "user", content: [{ type: "tool_result", content: "ok" } as Record<string, unknown>] },
    ];
    expect(readerText(messages)).toBe("");
    expect(carriesToolResult(messages)).toBe(true);
  });

  it("removes a client interruption marker without dropping the prompt", () => {
    expect(readerText([{ role: "user", content: "[Request interrupted by user for tool use]" }])).toBe("");
    expect(readerText([{
      role: "user",
      content: "[Request interrupted by user for tool use]\n\nduckling",
    }])).toBe("duckling");
    expect(readerText([{
      role: "user",
      content: [
        { type: "text", text: "[Request interrupted by user for tool use]" },
        { type: "text", text: "duckling" },
      ],
    }])).toBe("duckling");
  });

  it("preserves ordinary prose that merely mentions the interruption marker", () => {
    const text = "Explain why [Request interrupted by user for tool use] appeared in this log.";
    expect(readerText([{ role: "user", content: text }])).toBe(text);
  });
});

describe("answering a book prompt", () => {
  it("installs missing exercise dependencies before any replay operation", () => {
    const dependencyState: { stepId?: string; confirmationToolId?: string; installToolId?: string } = {};
    const step = content.steps.find((candidate) => candidate.id === "py-9-01") as ReplayStep;
    let installed = false;
    const dependencyCheck = () => ({
      dependencies: step.dependencies!.map((dependency) => ({ dependency, available: installed })),
      missing: installed ? [] : step.dependencies!,
      runtime: { command: ["python3"], display: "python3" },
      installTarget: "/home/student/.local/lib/python/site-packages",
    });

    const question = respond(
      { messages: [{ role: "user", content: step.prompt }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { dependencies: dependencyState, dependencyCheck },
    );
    expect(question.toolUse?.name).toBe("AskUserQuestion");
    expect(question.toolUse?.id).toStartWith("aifirst_dependency_confirm_");
    expect(question.text).toContain("pygame, Pillow");

    const install = respond({
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: question.toolUse?.id,
        content: '{"answers":{"Dependencies":"Install dependencies"}}',
      }] }],
      tools: NATIVE_TOOLS_WITH_QUESTION,
    }, content, log, { dependencies: dependencyState, dependencyCheck });
    expect(install.toolUse?.name).toBe("Bash");
    expect(install.toolUse?.input.command).toBe("aifirst dependencies install py-9-01 --yes --format json");

    installed = true;
    const replay = respond({
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: install.toolUse?.id,
        content: '{"ok":true}',
      }] }],
      tools: NATIVE_TOOLS_WITH_QUESTION,
    }, content, log, { dependencies: dependencyState, dependencyCheck });
    expect(replay.toolUse?.id).toBe("aifirst_replay_py-9-01_0");
    expect(dependencyState).toEqual({});
  });

  it("cancels a dependency prompt without starting the replay", () => {
    const dependencies: { stepId?: string; confirmationToolId?: string; installToolId?: string } = {};
    const step = content.steps.find((candidate) => candidate.id === "py-9-01") as ReplayStep;
    const dependencyCheck = () => ({
      dependencies: step.dependencies!.map((dependency) => ({ dependency, available: false })),
      missing: step.dependencies!,
      runtime: { command: ["python3"], display: "python3" },
      installTarget: "/tmp/user-site",
    });
    const question = respond(
      { messages: [{ role: "user", content: step.prompt }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { dependencies, dependencyCheck },
    );
    const cancelled = respond({
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: question.toolUse?.id,
        content: '{"answers":{"Dependencies":"Cancel exercise"}}',
      }] }],
      tools: NATIVE_TOOLS_WITH_QUESTION,
    }, content, log, { dependencies, dependencyCheck });
    expect(cancelled.stopReason).toBe("end_turn");
    expect(cancelled.toolUse).toBeUndefined();
    expect(cancelled.text).toContain("No files were changed");
    expect(dependencies).toEqual({});
  });

  it("ignores a stale dependency answer after a newer exercise replaces it", () => {
    const dependencies: { stepId?: string; confirmationToolId?: string; installToolId?: string } = {};
    const dependencyCheck = (step: ReplayStep) => ({
      dependencies: step.dependencies!.map((dependency) => ({ dependency, available: false })),
      missing: step.dependencies!,
      runtime: { command: ["python3"], display: "python3" },
      installTarget: "/tmp/user-site",
    });
    const duckling = content.steps.find((candidate) => candidate.id === "py-9-01") as ReplayStep;
    const editor = content.steps.find((candidate) => candidate.id === "py-10-01") as ReplayStep;
    const first = respond(
      { messages: [{ role: "user", content: duckling.prompt }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { dependencies, dependencyCheck },
    );
    const second = respond(
      { messages: [{ role: "user", content: editor.prompt }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { dependencies, dependencyCheck },
    );
    expect(second.toolUse?.id).toStartWith("aifirst_dependency_confirm_");
    expect(second.toolUse?.id).not.toBe(first.toolUse?.id);

    const repeated = respond({
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: first.toolUse?.id,
        content: '{"answers":{"Dependencies":"Cancel exercise"}}',
      }] }],
      tools: NATIVE_TOOLS_WITH_QUESTION,
    }, content, log, { dependencies, dependencyCheck });
    expect(repeated.toolUse?.id).toBe(second.toolUse?.id);
    expect(repeated.exerciseId).toBe("py-10-01");
  });

  it("uses Claude's native choice box when the client advertises it", () => {
    const confirmation: { stepId?: string; confirmationToolId?: string } = {};
    const reply = respond(
      { messages: [{ role: "user", content: "write hello world" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation },
    );

    expect(reply.stopReason).toBe("tool_use");
    expect(reply.exerciseId).toBe("py-1-01");
    expect(reply.toolUse?.name).toBe("AskUserQuestion");
    expect(reply.toolUse?.id).toStartWith("aifirst_confirm_");
    expect(confirmation.confirmationToolId).toBe(reply.toolUse?.id);
    expect(JSON.stringify(reply.toolUse?.input)).toContain("Run this replay");
  });

  it("re-presents a pending confirmation when Claude resumes with no content", () => {
    const confirmation: { stepId?: string; stepIds?: string[]; confirmationToolId?: string } = {};
    const first = respond(
      { messages: [{ role: "user", content: "fox" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation },
    );
    const firstId = first.toolUse?.id;
    expect(firstId).toStartWith("aifirst_confirm_");
    expect(confirmation.stepId).toBe("py-9-02");
    expect(confirmation.confirmationToolId).toBe(firstId);

    const resumed = respond(
      { messages: [{ role: "user", content: "(no content)" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation },
    );
    expect(resumed.exerciseId).toBe("py-9-02");
    expect(resumed.stopReason).toBe("tool_use");
    expect(resumed.toolUse?.id).toBe(firstId);
    expect(resumed.toolUse?.name).toBe("AskUserQuestion");
    expect(resumed.text).not.toContain("isn't a prompt from the book");
    expect(resumed.toolUse?.name).not.toBe("Write");
  });

  it("runs only the replay encoded in the accepted native choice", () => {
    const confirmation: { stepId?: string; confirmationToolId?: string } = {};
    const question = respond(
      { messages: [{ role: "user", content: "write hello world" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation },
    );
    const reply = respond({
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: question.toolUse?.id,
        content: '{"answers":{"AI First":"Run this replay"}}',
      }] }],
      tools: NATIVE_TOOLS_WITH_QUESTION,
    }, content, log, { confirmation });

    expect(reply.exerciseId).toBe("py-1-01");
    expect(reply.stopReason).toBe("tool_use");
    expect(reply.toolUse?.id).toBe("aifirst_replay_py-1-01_0");
    expect(reply.toolUse?.name).toBe("Write");
    expect(confirmation.confirmationToolId).toBeUndefined();
  });

  it("keeps stateless confirmation working without encoding the exercise in the tool id", () => {
    const workspace = mkdtempSync(join(tmpdir(), "aifirst-stateless-confirmation-"));
    const originalCwd = process.cwd();
    process.chdir(workspace);
    try {
      const question = respond(
        { messages: [{ role: "user", content: "write hello world" }], tools: NATIVE_TOOLS_WITH_QUESTION },
        content,
        log,
      );
      expect(question.toolUse?.id).toStartWith("aifirst_confirm_");
      expect(question.toolUse?.id).not.toContain("py-1-01");

      const accepted = respond({
        messages: [{ role: "user", content: [{
          type: "tool_result",
          tool_use_id: question.toolUse?.id,
          content: '{"answers":{"AI First":"Run this replay"}}',
        }] }],
        tools: NATIVE_TOOLS_WITH_QUESTION,
      }, content, log);
      expect(accepted.exerciseId).toBe("py-1-01");
      expect(accepted.toolUse?.id).toBe("aifirst_replay_py-1-01_0");
    } finally {
      process.chdir(originalCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not run a replay when the native choice is cancelled", () => {
    const confirmation: { stepId?: string; confirmationToolId?: string } = {};
    const question = respond(
      { messages: [{ role: "user", content: "write hello world" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation },
    );
    const reply = respond({
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: question.toolUse?.id,
          content: '{"answers":{"AI First":"Cancel"}}',
        }],
      }],
      tools: NATIVE_TOOLS_WITH_QUESTION,
    }, content, log, { confirmation });

    expect(reply.exerciseId).toBe("py-1-01");
    expect(reply.stopReason).toBe("end_turn");
    expect(reply.toolUse).toBeUndefined();
    expect(reply.text).toBe("Replay cancelled.");
    expect(confirmation.confirmationToolId).toBeUndefined();
  });

  it("ignores a stale cancellation when a newer fuzzy confirmation is active", () => {
    const confirmation: { stepId?: string; confirmationToolId?: string } = {};
    const first = respond(
      { messages: [{ role: "user", content: "write hello world" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation },
    );
    const firstId = first.toolUse?.id;
    const cancelled = respond({
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: firstId,
        content: '{"answers":{"AI First":"Cancel"}}',
      }] }],
      tools: NATIVE_TOOLS_WITH_QUESTION,
    }, content, log, { confirmation });
    expect(cancelled.text).toBe("Replay cancelled.");

    const second = respond(
      { messages: [{ role: "user", content: "write hello world" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation },
    );
    const secondId = second.toolUse?.id;
    expect(secondId).toStartWith("aifirst_confirm_");
    expect(secondId).not.toBe(firstId);

    const stateBeforeStaleResult = structuredClone(confirmation);
    const repeated = respond({
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: firstId,
        content: '{"answers":{"AI First":"Cancel"}}',
      }] }],
      tools: NATIVE_TOOLS_WITH_QUESTION,
    }, content, log, { confirmation });
    expect(repeated.toolUse?.id).toBe(secondId);
    expect(confirmation).toEqual(stateBeforeStaleResult);

    const accepted = respond({
      messages: [{ role: "user", content: [
        {
          type: "tool_result",
          tool_use_id: firstId,
          content: '{"answers":{"AI First":"Cancel"}}',
        },
        {
          type: "tool_result",
          tool_use_id: secondId,
          content: '{"answers":{"AI First":"Run this replay"}}',
        },
      ] }],
      tools: NATIVE_TOOLS_WITH_QUESTION,
    }, content, log, { confirmation });
    expect(accepted.exerciseId).toBe("py-1-01");
    expect(accepted.toolUse?.id).toBe("aifirst_replay_py-1-01_0");
    expect(confirmation.confirmationToolId).toBeUndefined();
  });

  it("keeps typed confirmation in server-owned transaction state", () => {
    const confirmation: { stepId?: string } = {};
    const first = respond(
      { messages: [{ role: "user", content: "write hello world" }], tools: NATIVE_TOOLS },
      content,
      log,
      { confirmation },
    );
    expect(first.stopReason).toBe("end_turn");
    expect(confirmation.stepId).toBe("py-1-01");

    const second = respond(
      { messages: [{ role: "user", content: "yes" }], tools: NATIVE_TOOLS },
      content,
      log,
      { confirmation },
    );
    expect(second.exerciseId).toBe("py-1-01");
    expect(second.stopReason).toBe("tool_use");
    expect(second.toolUse?.id).toBe("aifirst_replay_py-1-01_0");
    expect(confirmation.stepId).toBeUndefined();
  });

  it("presents ambiguous matches in a picker and plans the selected exercise", () => {
    const confirmation: { stepId?: string; stepIds?: string[] } = {};
    const planning = { answers: {} };
    const first = respond(
      { messages: [{ role: "user", content: "levels" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation, planning },
    );
    expect(first.exerciseId).toBeUndefined();
    expect(first.stopReason).toBe("tool_use");
    expect(first.toolUse?.id).toStartWith("aifirst_choose_replay_");
    expect(JSON.stringify(first.toolUse?.input)).toContain("Add Two Harder Levels (py-9-03)");
    expect(JSON.stringify(first.toolUse?.input)).toContain("java-6-04");
    expect(JSON.stringify(first.toolUse?.input)).toContain("None of these");
    expect(first.text).not.toContain("from enum import Enum");

    const second = respond(
      {
        messages: [{
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: first.toolUse?.id,
            content: '{"answers":{"Exercise":"Add Two Harder Levels (py-9-03)"}}',
          }],
        }],
        tools: NATIVE_TOOLS_WITH_QUESTION,
      },
      content,
      log,
      { confirmation, planning },
    );
    expect(second.exerciseId).toBe("py-9-03");
    expect(second.stopReason).toBe("tool_use");
    expect(second.toolUse?.name).toBe("AskUserQuestion");
    expect(second.text).toContain("self-contained build path");
  });

  it("does nothing when the ambiguous-match picker selects no exercise", () => {
    const confirmation: { stepId?: string; stepIds?: string[] } = {};
    const planning = { answers: {} };
    const picker = respond(
      { messages: [{ role: "user", content: "levels" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation, planning },
    );
    const reply = respond(
      {
        messages: [{
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: picker.toolUse?.id,
            content: '{"answers":{"Exercise":"None of these"}}',
          }],
        }],
        tools: NATIVE_TOOLS_WITH_QUESTION,
      },
      content,
      log,
      { confirmation, planning },
    );
    expect(reply.stopReason).toBe("end_turn");
    expect(reply.toolUse).toBeUndefined();
    expect(reply.exerciseId).toBeUndefined();
    expect(reply.text).toBe("No exercise selected. Nothing was changed or recorded.");
    expect(confirmation.stepId).toBeUndefined();
    expect(confirmation.stepIds).toBeUndefined();
    expect(planning).toEqual({ answers: {} });
  });

  it("does not reuse a cancelled picker transaction for the next ambiguous prompt", () => {
    const confirmation: { stepId?: string; stepIds?: string[] } = {};
    const planning = { answers: {} };
    const first = respond(
      { messages: [{ role: "user", content: "duckling" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation, planning },
    );
    const firstId = first.toolUse?.id;
    expect(firstId).toStartWith("aifirst_choose_replay_");

    const cancelled = respond(
      {
        messages: [{
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: firstId,
            content: '{"answers":{"Exercise":"None of these"}}',
          }],
        }],
        tools: NATIVE_TOOLS_WITH_QUESTION,
      },
      content,
      log,
      { confirmation, planning },
    );
    expect(cancelled.text).toBe("No exercise selected. Nothing was changed or recorded.");

    const second = respond(
      { messages: [{ role: "user", content: "duckling" }], tools: NATIVE_TOOLS_WITH_QUESTION },
      content,
      log,
      { confirmation, planning },
    );
    const secondId = second.toolUse?.id;
    expect(secondId).toStartWith("aifirst_choose_replay_");
    expect(secondId).not.toBe(firstId);

    const selected = respond(
      {
        messages: [{
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: firstId,
              content: '{"answers":{"Exercise":"None of these"}}',
            },
            {
              type: "tool_result",
              tool_use_id: secondId,
              content: '{"answers":{"Exercise":"Design a Level Editor (py-10-01)"}}',
            },
          ],
        }],
        tools: NATIVE_TOOLS_WITH_QUESTION,
      },
      content,
      log,
      { confirmation, planning },
    );
    expect(selected.exerciseId).toBe("py-10-01");
    expect(selected.toolUse?.name).toBe("AskUserQuestion");
    expect(selected.text).not.toBe("No exercise selected. Nothing was changed or recorded.");
  });

  it("returns the book envelope and starts its exact replay with a native tool", () => {
    const reply = respond({ messages: [{ role: "user", content: "Write a Hello World app" }], tools: NATIVE_TOOLS }, content, log);

    expect(reply.exerciseId).toBe("py-1-01");
    expect(reply.stopReason).toBe("tool_use");
    expect(reply.toolUse?.name).toBe("Write");
    expect(reply.toolUse?.input.content).toBe('print("Hello, World!")\n');
    expect(reply.text).toContain("Empty directory, so I'll create a simple Python Hello World script.");

    // The code in the reply is the book's, byte for byte.
    const step = content.steps.find((s) => s.id === "py-1-01")!;
    expect(reply.toolUse?.input.content).toBe(`${step.response}\n`);
  });

  it("keeps the explanation in the completion envelope", () => {
    const first = respond({ messages: [{ role: "user", content: "Write a Hello World app" }], tools: NATIVE_TOOLS }, content, log);
    const second = respond({
      messages: [
        { role: "user", content: "Write a Hello World app" },
        { role: "assistant", content: [{ type: "tool_use", tool_use_id: first.toolUse?.id, name: "Write", input: first.toolUse?.input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: first.toolUse?.id, content: "" }] },
        { role: "system", content: "Claude session metadata" },
        { role: "assistant", content: [{ type: "tool_use", tool_use_id: "aifirst_replay_py-1-01_1", name: "Bash", input: { command: "python3 hello.py" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "aifirst_replay_py-1-01_1", content: "Hello, World!\n" }] },
        { role: "system", content: "Claude session metadata" },
      ],
      tools: NATIVE_TOOLS,
    }, content, log);
    const step = content.steps.find((s) => s.id === "py-1-01")!;
    expect(second.stopReason).toBe("end_turn");
    expect(second.text).toContain(step.explanation!.summary);
    expect(second.text).toContain("## Replay completed");
    expect(second.text).not.toContain("**Book:**");
  });

  it("still answers when the client offers no shell tool", () => {
    const workspace = mkdtempSync(join(tmpdir(), "aifirst-responder-no-tools-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(workspace);
      const reply = respond(
        { messages: [{ role: "user", content: "Write a Hello World app" }], tools: [] },
        content,
        log,
      );
      expect(reply.stopReason).toBe("end_turn");
      expect(reply.toolUse).toBeUndefined();
      expect(reply.text).toContain("$ python3 hello.py");
    } finally {
      process.chdir(originalCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps a Python reader out of the Java book", () => {
    const reply = respond(userTurn("Write a Hello World app"), content, log, { language: "python" });
    expect(reply.exerciseId?.startsWith("py-")).toBe(true);
  });

  it("advances one native tool per replay turn", () => {
    const first = respond({ messages: [{ role: "user", content: "Write a Hello World app" }], tools: NATIVE_TOOLS }, content, log);
    const second = respond({
      messages: [
        { role: "user", content: "Write a Hello World app" },
        { role: "assistant", content: [{ type: "tool_use", tool_use_id: first.toolUse?.id, name: "Write", input: first.toolUse?.input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: first.toolUse?.id, content: "File written" }] },
      ],
      tools: NATIVE_TOOLS,
    }, content, log);
    expect(second.stopReason).toBe("tool_use");
    expect(second.toolUse?.name).toBe("Bash");
    expect(second.toolUse?.input.command).toBe("python3 hello.py");
    expect(second.text).toContain("### Turn 2");
  });

  it("continues after a command that was captured as an expected failure", () => {
    const expectedFailureContent = structuredClone(content);
    const step = expectedFailureContent.steps.find((candidate) => candidate.id === "py-1-01")! as ReplayStep;
    step.replay = {
      prompt: "Replay an expected failure",
      operations: [
        { type: "command", command: ["python3", "broken.py"], expectedExitCode: 1 },
        { type: "write", path: "broken.py", content: "print('fixed')\n" },
      ],
      commentary: ["Confirm the failure first.", "Apply the captured repair."],
    };

    const first = respond(
      { messages: [{ role: "user", content: "Replay an expected failure" }], tools: NATIVE_TOOLS },
      expectedFailureContent,
      log,
    );
    const second = respond({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", tool_use_id: first.toolUse?.id }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: first.toolUse?.id,
            is_error: true,
            content: "Exit code 1\nTraceback: expected failure",
          }],
        },
      ],
      tools: NATIVE_TOOLS,
    }, expectedFailureContent, log);

    expect(second.stopReason).toBe("tool_use");
    expect(second.toolUse?.name).toBe("Write");
    expect(second.toolUse?.input.content).toBe("print('fixed')\n");
  });
});

describe("closing the loop", () => {
  it("reports progress once the exercise has run", () => {
    const reply = respond(
      {
        messages: [
          { role: "user", content: "Write a Hello World app" },
          { role: "assistant", content: [{ type: "tool_use" } as Record<string, unknown>] },
          { role: "user", content: [{ type: "tool_result", content: "Hello, World!" } as Record<string, unknown>] },
        ],
        tools: TOOLS,
      },
      content,
      log,
    );
    expect(reply.stopReason).toBe("end_turn");
    expect(reply.toolUse).toBeUndefined();
    expect(reply.text).toContain("Ran clean");
  });
});

describe("chat next", () => {
  it("returns the complete exercise and one shell action", () => {
    const reply = respond(
      { messages: [{ role: "user", content: "aifirst next" }], tools: TOOLS },
      content,
      log,
    );

    expect(reply.stopReason).toBe("tool_use");
    expect(reply.exerciseId).toBe(content.examples[0].id);
    const step = content.steps.find((item) => item.exampleId === content.examples[0].id)!;
    expect(reply.text).toContain(step.prompt);
    expect(reply.text).toContain(`\`\`\`${content.examples[0].language}`);
    expect(reply.toolUse?.input.command).toBe(`aifirst run ${step.id}`);
  });

  it("returns a complete manual action without a shell tool", () => {
    const reply = respond(
      { messages: [{ role: "user", content: "aifirst next" }], tools: [] },
      content,
      log,
    );

    const step = content.steps.find((item) => item.exampleId === content.examples[0].id)!;
    expect(reply.stopReason).toBe("end_turn");
    expect(reply.toolUse).toBeUndefined();
    expect(reply.text).toContain(`aifirst run ${step.id}`);
    expect(reply.text).toContain(step.prompt);
  });
});

describe("a question the book cannot answer", () => {
  const offBook = respond(userTurn("why is my recursion segfaulting in Rust"), content, log);

  it("refuses rather than guessing", () => {
    expect(offBook.stopReason).toBe("end_turn");
    expect(offBook.toolUse).toBeUndefined();
    expect(offBook.exerciseId).toBeUndefined();
  });

  it("says how to leave book mode, so the reader is not stuck", () => {
    expect(offBook.text).toContain("aifirst book-mode off");
  });

  it("never pretends a model answered", () => {
    expect(offBook.text.toLowerCase()).toContain("no model is running");
  });
});
