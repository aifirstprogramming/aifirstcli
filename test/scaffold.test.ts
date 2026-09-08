import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";
import { writeScaffold } from "../src/content/scaffold";
import type { Step } from "../src/content/types";
import { GeneratedFileStore } from "../src/generatedFiles";

const { content } = resolveContent();
const binarySteps = content.steps.filter((step) =>
  step.scaffold?.files?.some((file) => "contentBase64" in file));
let workspace = "";

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("binary exercise scaffolds", () => {
  test("materializes every tracked PNG exactly once for every asset-backed replay", () => {
    expect(binarySteps.map((step) => step.id)).toEqual([
      "py-9-01", "py-9-02", "py-9-03", "py-10-01", "py-10-02", "py-10-03",
    ]);
    for (const step of binarySteps) {
      workspace = mkdtempSync(join(tmpdir(), `aifirst-scaffold-${step.id}-`));
      const binaryFiles = step.scaffold!.files.filter((file) => "contentBase64" in file);
      const paths = binaryFiles.map((file) => file.path);
      expect(new Set(paths).size, step.id).toBe(paths.length);
      expect(writeScaffold(workspace, step, content, { binaryOnly: true }), step.id).toEqual(paths);
      for (const path of paths.filter((candidate) => candidate.endsWith(".png"))) {
        const data = readFileSync(join(workspace, path));
        expect(data.length, `${step.id}: ${path}`).toBeGreaterThan(8);
        expect(data.subarray(0, 8), `${step.id}: ${path}`).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
      }
      expect(writeScaffold(workspace, step, content, { binaryOnly: true }), step.id).toEqual([]);
      rmSync(workspace, { recursive: true, force: true });
      workspace = "";
    }
  });

  test("refreshes only unchanged generated scaffold files", () => {
    workspace = mkdtempSync(join(tmpdir(), "aifirst-scaffold-refresh-"));
    const store = new GeneratedFileStore(join(workspace, "state"));
    const oldStep = { scaffold: { files: [{ path: "runner.py", content: "print('old')" }] } } as Step;
    const newStep = { scaffold: { files: [{ path: "runner.py", content: "print('new')" }] } } as Step;
    const latestStep = { scaffold: { files: [{ path: "runner.py", content: "print('latest')" }] } } as Step;

    expect(writeScaffold(workspace, oldStep, content, { generatedFiles: store })).toEqual(["runner.py"]);
    expect(writeScaffold(workspace, newStep, content, { generatedFiles: store })).toEqual(["runner.py"]);
    expect(readFileSync(join(workspace, "runner.py"), "utf8")).toBe("print('new')\n");

    writeFileSync(join(workspace, "runner.py"), "# learner change\n");
    expect(writeScaffold(workspace, latestStep, content, { generatedFiles: store })).toEqual([]);
    expect(readFileSync(join(workspace, "runner.py"), "utf8")).toBe("# learner change\n");
  });
});
