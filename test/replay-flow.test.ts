import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeReplay, executeReplayAsync, executeReplayOperation, executeReplayOperationAsync, materializeReplayCommand } from "../src/replay/executor";
import { resolveReplay } from "../src/replay/resolver";
import { clearPendingReplay, confirmationAnswer, readPendingReplay, replaySelection, savePendingReplay } from "../src/replay/pending";
import type { Content, ReplayStep } from "../src/content/types";
import { resolveContent } from "../src/content";

function content(...steps: ReplayStep[]): Content {
  return { books: [], examples: [], steps, version: "test" } as Content;
}

function step(id: string, prompt: string): ReplayStep {
  return {
    id,
    prompt,
    response: "",
    language: "python",
    index: 1,
    total: 1,
    exampleId: id,
    interactive: false,
    execution: { mode: "run", launch: { surface: "terminal" } },
    replay: { prompt, operations: [] },
  };
}

let root: string;
const originalState = process.env.AIFIRST_STATE_DIR;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (originalState === undefined) delete process.env.AIFIRST_STATE_DIR;
  else process.env.AIFIRST_STATE_DIR = originalState;
});

describe("replay resolution", () => {
  it("prefers one exact normalized prompt", () => {
    const match = resolveReplay("  WRITE\nA hello world app ", content(step("one", "Write a hello world app")));
    expect(match.kind).toBe("exact");
    if (match.kind === "exact") expect(match.step.id).toBe("one");
  });

  it("treats the published book prompt as an exact replay alias", () => {
    const candidate = { ...step("one", "Write a hello world app"), replay: { prompt: "Write hello world app", operations: [] } };
    expect(resolveReplay("Write a hello world app", content(candidate)).kind).toBe("exact");
  });

  it("returns a fuzzy candidate without executing it", () => {
    const match = resolveReplay("make a hello world demo", content(step("one", "Write a hello world program")));
    expect(match.kind).toBe("fuzzy");
  });

  it("treats one distinctive phrase as a confirmable partial match", () => {
    const match = resolveReplay(
      "baby duckling who is trying to find its mother",
      resolveContent().content,
    );
    expect(match.kind).toBe("fuzzy");
    if (match.kind === "fuzzy") expect(match.step.id).toBe("py-9-01");
  });

  it("routes a generic ambiguous match through confirmation instead of execution", () => {
    const match = resolveReplay("write a hello program", content(step("one", "Write a hello world program"), step("two", "Write a hello console program")));
    expect(match.kind).toBe("ambiguous");
    if (match.kind === "ambiguous") expect(match.candidates.map((candidate) => candidate.step.id)).toEqual(["one", "two"]);
  });

  it("ranks the Python multi-level replay first for the ambiguous prompt levels", () => {
    const match = resolveReplay("levels", resolveContent().content);
    expect(match.kind).toBe("ambiguous");
    if (match.kind === "ambiguous") {
      expect(match.candidates[0].step.id).toBe("py-9-03");
      expect(match.candidates.some((candidate) => candidate.step.id === "java-6-04")).toBe(true);
    }
  });

  it("returns only the top three ambiguous exercises", () => {
    const match = resolveReplay("hello", content(
      step("one", "hello aaa"),
      step("two", "hello bbb"),
      step("three", "hello ccc"),
      step("four", "hello ddd"),
    ));
    expect(match.kind).toBe("ambiguous");
    if (match.kind === "ambiguous") expect(match.candidates.map((candidate) => candidate.step.id)).toEqual(["one", "two", "three"]);
  });
});

describe("replay execution", () => {
  it("materializes portable Python commands with the selected Windows launcher", () => {
    const command = materializeReplayCommand({
      type: "command",
      command: ["bash", "-lc", "python3 main.py"],
      portableCommand: ["<python>", "main.py"],
    }, { command: ["py", "-3"], display: "py -3" });
    expect(command).toEqual(["py", "-3", "main.py"]);
  });

  it("runs compound portable shell scripts without invoking external bash", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-portable-shell-"));
    const result = await executeReplayOperationAsync({
      type: "command",
      command: ["bash", "-lc", "python3 -c \"print('portable')\""],
      portableCommand: ["<shell>", "<python> -c \"print('portable')\""],
      expectedExitCode: 0,
      expectedStdout: "portable\n",
      expectedStderr: "",
    }, root);
    expect(result.ok).toBe(true);
    expect(result.command?.command[0]).toBe("<shell>");
    expect(result.command?.stdout.replace(/\r\n/g, "\n")).toBe("portable\n");
  });

  it("lets the portable shell remove more than one file", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-remove-many-"));
    writeFileSync(join(root, "one.txt"), "one\n");
    writeFileSync(join(root, "two.txt"), "two\n");
    const result = await executeReplayOperationAsync({
      type: "command",
      command: ["bash", "-lc", "rm one.txt two.txt"],
      portableCommand: ["<shell>", "rm one.txt two.txt"],
      expectedExitCode: 0,
    }, root);

    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "one.txt"))).toBe(false);
    expect(existsSync(join(root, "two.txt"))).toBe(false);
  });

  it("materializes privacy-safe workspace placeholders before executing commands", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-workspace-"));
    const result = executeReplayOperation({
      type: "command",
      command: ["bash", "-lc", 'test -d "<workspace>" && printf workspace-ok'],
      expectedExitCode: 0,
      expectedStdout: "workspace-ok",
    }, root);
    expect(result.ok).toBe(true);
    expect(result.command?.command.at(-1)).toContain('test -d "."');
  });

  it("writes files, runs commands, and checks expected output", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-flow-"));
    process.env.AIFIRST_STATE_DIR = root;
    const result = executeReplay({ operations: [
      { type: "write", path: "nested/value.txt", content: "hello\n" },
      { type: "command", command: [process.execPath, "-e", "process.stdout.write(require('fs').readFileSync('nested/value.txt','utf8'))"], expectedStdout: "hello\n" },
    ] }, root);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "nested/value.txt"), "utf8")).toBe("hello\n");
    expect(result.commands[0]?.stdout).toBe("hello\n");
  });

  it("can relax captured output while still requiring the captured exit code", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-relaxed-"));
    const replay = { operations: [{
      type: "command" as const,
      command: [process.execPath, "-e", "console.log('current output')"],
      expectedExitCode: 0,
      expectedStdout: "captured output\n",
    }] };

    expect((await executeReplayAsync(replay, root)).ok).toBe(false);
    expect((await executeReplayAsync(replay, root, undefined, { relaxOutput: true })).ok).toBe(true);
    expect((await executeReplayAsync({ operations: [{
      ...replay.operations[0],
      command: [process.execPath, "-e", "process.exit(2)"],
    }] }, root, undefined, { relaxOutput: true })).ok).toBe(false);
  });

  it("stops after the first operation that fails verification", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-fail-fast-"));
    const result = executeReplay({ operations: [
      { type: "write", path: "before.txt", content: "before\n" },
      { type: "command", command: [process.execPath, "-e", "process.exit(1)"], expectedExitCode: 0 },
      { type: "write", path: "after.txt", content: "after\n" },
    ] }, root);

    expect(result.ok).toBe(false);
    expect(existsSync(join(root, "before.txt"))).toBe(true);
    expect(existsSync(join(root, "after.txt"))).toBe(false);
  });

  it("skips an optional graphical launch in a headless Linux session", () => {
    if (process.platform !== "linux") return;
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-headless-"));
    const display = process.env.DISPLAY;
    const wayland = process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      const result = executeReplayOperation({
        type: "command",
        command: ["definitely-not-a-real-gui-command"],
        graphical: true,
      }, root);
      expect(result.ok).toBe(true);
      expect(result.command?.stdout).toContain("Skipped graphical launch");
    } finally {
      if (display === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = display;
      if (wayland === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = wayland;
    }
  });

  it("does not permit a replay to escape its workspace", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-flow-"));
    expect(() => executeReplay({ operations: [{ type: "write", path: "../outside.txt", content: "no" }] }, root)).toThrow("escapes");
  });

  it("applies captured edits and validates captured reads", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-flow-"));
    writeFileSync(join(root, "value.txt"), "before\n");
    const result = executeReplay({ operations: [
      { type: "read", path: "value.txt" },
      { type: "edit", path: "value.txt", oldText: "before", newText: "after" },
    ] }, root);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("after\n");
  });
});

describe("fuzzy confirmation state", () => {
  it("normalizes yes/no answers and expires through the shared store", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-replay-flow-"));
    expect(confirmationAnswer(" YES! ")).toBe("yes");
    expect(confirmationAnswer("no")).toBe("no");
    savePendingReplay(["one", "two", "three"], root);
    expect(readPendingReplay(root)?.stepIds).toEqual(["one", "two", "three"]);
    expect(replaySelection("2", ["one", "two", "three"])).toBe("two");
    expect(replaySelection("pick three", ["one", "two", "three"])).toBe("three");
    expect(replaySelection("None of these", ["one", "two", "three"])).toBe("cancel");
  });
});
