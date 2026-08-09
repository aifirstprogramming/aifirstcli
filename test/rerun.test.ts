import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whole chapters evolve a single file. Python 7 builds one test file across five
 * exercises, and java-6-01/05/07/09 all declare `public class Thermostat`, so javac
 * requires the same filename each time.
 *
 * In 0.3.0 that combination produced a false completion: the file-exists refusal
 * told the reader to pass `--force`, and `--force` skipped the refusal without
 * writing anything, so the *previous* exercise's file ran and the current one was
 * recorded as done. A learner banked a green tick for code that never ran.
 */

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "aifirst-rerun-"));
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

async function aifirst(args: string[]): Promise<Run> {
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
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, code: proc.exitCode ?? 0 };
}

/** The two Python chapter 7 exercises that share assert.py. */
const FIRST = "py-7-01";
const SECOND = "py-7-02";
const SHARED = "assert.py";

describe("an exercise that reuses the previous one's filename", () => {
  it("replaces the previous exercise's code and runs the right one", async () => {
    await aifirst(["run", FIRST]);
    const r = await aifirst(["run", SECOND, "--format", "json"]);
    const out = JSON.parse(r.stdout);

    expect(out.wrote).toBe(true);
    expect(out.replaced).toBe(FIRST);
    expect(out.ran.ok).toBe(true);
    expect(out.recorded).toBe(true);

    // The decisive check: what is on disk is the exercise that was recorded.
    const onDisk = readFileSync(join(sandbox, SHARED), "utf8");
    const canonical = JSON.parse((await aifirst(["show", SECOND, "--format", "json"])).stdout).steps[0].response;
    expect(onDisk.trimEnd()).toBe(canonical.trimEnd());
  });

  it("records each exercise on its own merits, not the previous one's file", async () => {
    await aifirst(["run", FIRST]);
    await aifirst(["run", SECOND]);
    const progress = JSON.parse((await aifirst(["progress", "--format", "json"])).stdout);
    expect(progress.overall.done).toBe(2);
  });
});

describe("a file the learner wrote themselves", () => {
  it("is never replaced silently", async () => {
    writeFileSync(join(sandbox, "mine.py"), "# my own attempt\nprint(1)\n");
    const r = await aifirst(["run", FIRST, "--into", "mine.py"]);
    expect(r.code).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("your own work");
    // Untouched.
    expect(readFileSync(join(sandbox, "mine.py"), "utf8")).toContain("my own attempt");
  });

  it("is not recorded as done when the run was refused", async () => {
    writeFileSync(join(sandbox, "mine.py"), "# my own attempt\nprint(1)\n");
    await aifirst(["run", FIRST, "--into", "mine.py"]);
    const progress = JSON.parse((await aifirst(["progress", "--format", "json"])).stdout);
    expect(progress.overall.done).toBe(0);
  });

  it("is replaced when --force is passed, and --force actually writes", async () => {
    writeFileSync(join(sandbox, "mine.py"), "# my own attempt\nprint(1)\n");
    const r = await aifirst(["run", FIRST, "--into", "mine.py", "--force", "--format", "json"]);
    const out = JSON.parse(r.stdout);

    expect(out.wrote).toBe(true);
    expect(out.ran.ok).toBe(true);
    // The regression: 0.3.0 skipped the refusal without writing, so the learner's
    // file was what ran.
    expect(readFileSync(join(sandbox, "mine.py"), "utf8")).not.toContain("my own attempt");
  });
});

describe("what `recorded` means", () => {
  it("only ever means this exercise's code ran", async () => {
    // Every recorded exercise must leave its own canonical code on disk.
    for (const id of [FIRST, SECOND]) {
      const r = await aifirst(["run", id, "--format", "json"]);
      const out = JSON.parse(r.stdout);
      if (!out.recorded) continue;
      const canonical = JSON.parse((await aifirst(["show", id, "--format", "json"])).stdout).steps[0].response;
      expect(readFileSync(out.path, "utf8").trimEnd()).toBe(canonical.trimEnd());
    }
  });

  it("re-running an already-written exercise is a no-op that still verifies", async () => {
    await aifirst(["run", FIRST]);
    const r = await aifirst(["run", FIRST, "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.wrote).toBe(false);
    expect(out.ran.ok).toBe(true);
    expect(existsSync(join(sandbox, SHARED))).toBe(true);
  });
});
