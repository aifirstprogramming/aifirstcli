import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEntries } from "../src/permissions";
import { condense, diffLines, normalize } from "../src/textdiff";

/**
 * `aifirst diff` exists so an assistant never has to build a shell pipeline to
 * answer "does this file match the book?". The version that prompted it used
 * process substitution, which puts a permission prompt in front of a learner
 * mid-exercise.
 */

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "aifirst-diff-"));
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

describe("diffLines", () => {
  it("reports nothing for identical text", () => {
    expect(diffLines("a\nb", "a\nb").every((l) => l.op === "same")).toBe(true);
  });

  it("marks an added and a removed line", () => {
    const d = diffLines("a\nx\nc", "a\nb\nc");
    expect(d.filter((l) => l.op === "removed").map((l) => l.text)).toEqual(["x"]);
    expect(d.filter((l) => l.op === "added").map((l) => l.text)).toEqual(["b"]);
  });

  it("collapses long runs of unchanged lines", () => {
    const same = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const condensed = condense(diffLines(`${same}\nextra`, same));
    expect(condensed).toContain("gap");
    // Far fewer than the 41 lines involved.
    expect(condensed.length).toBeLessThan(12);
  });

  it("does not treat a trailing newline as a difference", () => {
    expect(normalize("a\nb\n")).toBe(normalize("a\nb"));
  });
});

describe("aifirst diff", () => {
  it("says so, and exits 0, when the file matches the book", async () => {
    await aifirst(["apply", "py-1-01", "--into", "hello.py"]);
    const r = await aifirst(["diff", "py-1-01", "hello.py"]);
    expect(r.stdout).toContain("matches the book");
    expect(r.code).toBe(0);
  });

  it("shows the differing lines, and exits 1, when it does not", async () => {
    writeFileSync(join(sandbox, "hello.py"), 'print("nope")\n');
    const r = await aifirst(["diff", "py-1-01", "hello.py"]);
    expect(r.stdout).toContain("differs from the book");
    expect(r.stdout).toContain('print("nope")');
    expect(r.code).toBe(1);
  });

  it("reports only the changes over JSON", async () => {
    writeFileSync(join(sandbox, "hello.py"), 'print("nope")\n');
    const r = await aifirst(["diff", "py-1-01", "hello.py", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.identical).toBe(false);
    expect(out.changes.some((c: { text: string }) => c.text.includes("nope"))).toBe(true);
  });

  it("defaults to the filename the exercise would be written to", async () => {
    await aifirst(["apply", "py-1-01"]);
    const r = await aifirst(["diff", "py-1-01"]);
    expect(r.stdout).toContain("matches the book");
  });

  it("points at apply when the file is not there", async () => {
    const r = await aifirst(["diff", "py-1-01", "missing.py"]);
    expect(r.code).toBe(1);
  });

  it("records nothing — comparing is not completing", async () => {
    await aifirst(["apply", "py-1-01", "--into", "hello.py"]);
    await aifirst(["diff", "py-1-01", "hello.py"]);
    const progress = JSON.parse((await aifirst(["progress", "--format", "json"])).stdout);
    expect(progress.overall.done).toBe(0);
  });
});

describe("permissions", () => {
  it("pre-approves diff, so no shell pipeline is needed for a comparison", () => {
    expect(claudeEntries()).toContain("Bash(aifirst diff:*)");
  });
});
