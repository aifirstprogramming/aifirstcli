import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";
import { writeScaffold } from "../src/content/scaffold";

const { content } = resolveContent();
const duckling = content.steps.find((step) => step.id === "py-9-01")!;
let workspace = "";

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("binary exercise scaffolds", () => {
  test("materializes every tracked duckling PNG exactly once", () => {
    workspace = mkdtempSync(join(tmpdir(), "aifirst-scaffold-"));
    const written = writeScaffold(workspace, duckling, content, { binaryOnly: true });
    expect(written).toHaveLength(10);
    expect(written).toContain("assets/fox.png");
    expect(readFileSync(join(workspace, "assets", "duckling.png")).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(writeScaffold(workspace, duckling, content, { binaryOnly: true })).toEqual([]);
  });
});
