import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeReplay } from "../src/replay/executor";
import { resolveReplay } from "../src/replay/resolver";
import { clearPendingReplay, confirmationAnswer, readPendingReplay, replaySelection, savePendingReplay } from "../src/replay/pending";
import type { Content, ReplayStep } from "../src/content/types";
import { resolveContent } from "../src/content";

function content(...steps: ReplayStep[]): Content {
  return { books: [], examples: [], steps, version: "test" } as Content;
}

function step(id: string, prompt: string): ReplayStep {
  return { id, prompt, response: "", language: "python", index: 1, total: 1, exampleId: id, interactive: false, replay: { prompt, operations: [] } };
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
