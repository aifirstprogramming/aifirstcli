import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The explanation a reader sees comes from the content pack, not from whatever model
 * happens to be driving the CLI.
 *
 * That is what makes the terminal and the VS Code extension agree: the extension has
 * no model and cannot write one, so anything generated at request time would simply
 * not exist there.
 */

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "aifirst-expl-"));
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

async function aifirst(args: string[]): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
    cwd: sandbox,
    env: {
      ...process.env,
      AIFIRST_STATE_DIR: join(sandbox, "state"),
      AIFIRST_HOME_OVERRIDE: join(sandbox, "home"),
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { stdout, code: proc.exitCode ?? 0 };
}

describe("stored explanations", () => {
  it("prints the book's walkthrough for an exercise", async () => {
    const r = await aifirst(["show", "java-4-01"]);
    expect(r.stdout).toContain("Explanation");
    expect(r.stdout).toContain("public static void showWelcomeMessage() {");
  });

  it("hands the explanation to an agent over JSON", async () => {
    const r = await aifirst(["show", "java-4-01", "--format", "json"]);
    const step = JSON.parse(r.stdout).steps[0];
    expect(step.explanation.summary.length).toBeGreaterThan(20);
    expect(step.explanation.lines.length).toBeGreaterThan(0);

    // Every quoted line must exist in the code, or the walkthrough is describing
    // something the reader cannot find on the page.
    const source = new Set(step.response.split("\n").map((l: string) => l.trim()));
    for (const line of step.explanation.lines) {
      expect(source.has(line.code.trim())).toBe(true);
    }
  });

  it("never shows the reader an internal command marker", async () => {
    const r = await aifirst(["show", "java-6-03"]);
    expect(r.stdout).not.toContain("__junit__");
  });
});
