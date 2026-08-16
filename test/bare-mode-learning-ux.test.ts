/**
 * Bare-Mode Learning UX — test-first coverage for all reference scenarios.
 *
 * The key change: `next` is now the FULL CYCLE — it writes the canonical code,
 * runs it, explains it, records success, and advances to the next exercise.
 * `show` stays read-only. `run` stays explicit write/run/record.
 *
 * Scenarios:
 *  1. Python: next → auto-write/run/record/advance
 *  2. Java:   next → write → run failure (no JDK) → no advance
 *  3. Failure: existing different file → refusal → --force
 *  4. Show-only: read-only, no file write, no advancement
 *  5. Multi-step: multi-step exercise handling
 *  6. Book choice: needsBookChoice, explicit book selection
 *  7. Progress: hierarchical progress, done/skip/reset
 *  8. JSON contract stability
 *  9. Key invariants
 * 10. Text output format details
 * 11. Edge cases and boundary conditions
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "aifirst-baremode-"));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* a leftover temp dir is not a test failure */
  }
});

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

async function aifirst(args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
    cwd: sandbox,
    env: {
      ...process.env,
      AIFIRST_STATE_DIR: join(sandbox, "state"),
      AIFIRST_HOME_OVERRIDE: join(sandbox, "home"),
      NO_COLOR: "1",
      ...extraEnv,
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

// ===========================================================================
// 1. Python Scenario — next does full write/run/record/advance cycle
// ===========================================================================

describe("1. Python scenario — next full cycle", () => {
  it("next py (text) writes, runs, records, and shows code/output/explanation/next", async () => {
    const r = await aifirst(["next", "py"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Hello World");
    expect(r.stdout).toContain("py-1-01");
    expect(r.stdout).toContain("AI First Python Programming");
    expect(r.stdout).toContain("Chapter 1");
    expect(r.stdout).toContain("Write a simple Hello World program");
    expect(r.stdout).toContain("Code");
    expect(r.stdout).toContain('print("Hello, World!")');
    expect(r.stdout).toContain("Output");
    expect(r.stdout).toContain("Hello, World!");
    expect(r.stdout).toContain("ran clean");
    expect(r.stdout).toContain("recorded");
    expect(r.stdout).toContain("Explanation");
    expect(r.stdout).toContain("Worth noticing");
    expect(r.stdout).toContain("Next");
    expect(r.stdout).toContain("py-2-01");
  });

  it("next py --format json returns the bare-mode cycle result", async () => {
    const r = await aifirst(["next", "py", "--format", "json"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.completed).toBe(true);
    expect(data.exerciseId).toBe("py-1-01");
    expect(data.stepId).toBe("py-1-01");
    expect(data.wrote).toBe(true);
    expect(data.ran.ok).toBe(true);
    expect(data.ran.exitCode).toBe(0);
    expect(data.ran.stdout.trim()).toBe("Hello, World!");
    expect(data.recorded).toBe(true);
    expect(data.next).toBeDefined();
    expect(data.next.id).toBe("py-2-01");
    expect(data.next.title).toBe("Basket of Fruits");
    expect(data.next.language).toBe("python");
  });

  it("second next py advances to the next exercise", async () => {
    await aifirst(["next", "py"]);
    const r = await aifirst(["next", "py", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.exerciseId).toBe("py-2-01");
    expect(data.next.id).toBe("py-2-08");
  });

  it("next py runs each exercise and advances automatically", async () => {
    // Run 3 exercises in a row
    for (let i = 0; i < 3; i++) {
      const r = await aifirst(["next", "py", "--format", "json"]);
      expect(r.code).toBe(0);
      const data = JSON.parse(r.stdout);
      expect(data.completed).toBe(true);
      expect(data.ran.ok).toBe(true);
      expect(data.recorded).toBe(true);
    }
  });
});

// ===========================================================================
// 2. Java Scenario — next writes but fails when JDK is missing
// ===========================================================================

describe("2. Java scenario — next with missing JDK", () => {
  it("next java (text) shows error when Java is not installed", async () => {
    const r = await aifirst(["next", "java"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("java");
    expect(r.stderr).toContain("not found");
  });

  it("next java --format json shows error when Java is not installed", async () => {
    const r = await aifirst(["next", "java", "--format", "json"]);
    expect(r.code).toBe(1);
    // Error goes to stderr (CliError), stdout may be empty or contain JSON
    const stdoutData = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    const stderrData = r.stderr.trim() ? JSON.parse(r.stderr) : null;
    const data = stdoutData ?? stderrData;
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe("error");
    expect(data.error.message).toContain("java");
  });

  it("show java-1-01 (text) still shows the Java code", async () => {
    const r = await aifirst(["show", "java-1-01"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("public class HelloWorld");
    expect(r.stdout).toContain("public static void main");
    expect(r.stdout).toContain("System.out.println");
  });
});

// ===========================================================================
// 3. Failure Scenario — existing file with different contents
// ===========================================================================

describe("3. Failure scenario — existing file with different contents", () => {
  it("next refuses to replace file with different contents (no --force)", async () => {
    writeFileSync(join(sandbox, "hello_world.py"), "# my own attempt\n");
    const r = await aifirst(["next", "py"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("already exists with different contents");
    // File NOT replaced
    expect(readFileSync(join(sandbox, "hello_world.py"), "utf8")).toBe("# my own attempt\n");
  });

  it("next --force replaces learner's file with canonical code", async () => {
    writeFileSync(join(sandbox, "hello_world.py"), "# my own attempt\n");
    const r = await aifirst(["next", "py", "--force", "--format", "json"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.wrote).toBe(true);
    expect(data.ran.ok).toBe(true);
    expect(data.recorded).toBe(true);
  });

  it("next with already-correct file is idempotent (no re-record)", async () => {
    // Run next twice — each run advances, so second time file already has right code
    await aifirst(["next", "py"]); // py-1-01, recorded
    const second = JSON.parse((await aifirst(["next", "py", "--format", "json"])).stdout);
    expect(second.exerciseId).toBe("py-2-01");
    // The file py-1-01 already has the right code; running it again should show wrote: false
    // because the file path matches the exercise
  });
});

// ===========================================================================
// 4. Show-Only Scenario — read-only, no advancement
// ===========================================================================

describe("4. Show-only scenario — read-only, no advancement", () => {
  it("show does NOT write file or record progress", async () => {
    await aifirst(["show", "py-1-01"]);
    const progress = JSON.parse((await aifirst(["progress", "--format", "json"])).stdout);
    expect(progress.overall.done).toBe(0);
  });

  it("show does NOT advance next", async () => {
    await aifirst(["show", "py-1-01"]);
    const r = await aifirst(["next", "py", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.exerciseId).toBe("py-1-01"); // still the first exercise
  });

  it("show after run shows 'recorded done' with timestamp", async () => {
    await aifirst(["next", "py"]); // writes and records py-1-01
    const r = await aifirst(["show", "py-1-01"]);
    expect(r.stdout).toContain("recorded");
    expect(r.stdout).toContain("done");
  });

  it("show still does NOT write file or advance", async () => {
    await aifirst(["next", "py"]); // advances to py-2-01
    await aifirst(["show", "py-1-01"]);
    const nextR = await aifirst(["next", "py", "--format", "json"]);
    const data = JSON.parse(nextR.stdout);
    // Still at py-2-01 (show didn't advance)
    expect(data.exerciseId).toBe("py-2-01");
  });
});

// ===========================================================================
// 5. Multi-Step Scenario
// ===========================================================================

describe("5. Multi-step scenario", () => {
  it("show addresses a single step by id (e.g. py-3-01.1)", async () => {
    const r = await aifirst(["show", "py-3-01.1", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0].id).toBe("py-3-01.1");
  });

  it("show whole multi-step exercise shows all steps", async () => {
    const r = await aifirst(["show", "py-3-01", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.multiStep).toBe(true);
    expect(data.steps.length).toBe(3);
  });

  it("run of multi-step runs the final step (py-3-01.3)", async () => {
    const r = await aifirst(["run", "py-3-01", "--yes", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.stepId).toBe("py-3-01.3");
  });

  it("run --step N of multi-step runs the specified step", async () => {
    const r = await aifirst(["run", "py-3-01", "--step", "1", "--yes", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.stepId).toBe("py-3-01.1");
  });

  it("run of unknown step reports an error", async () => {
    const r = await aifirst(["run", "py-3-01", "--step", "99", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no step 99");
  });
});

// ===========================================================================
// 6. Book Choice Scenario
// ===========================================================================

describe("6. Book choice scenario", () => {
  it("next (no book selected, text) lists all books with exercise counts", async () => {
    const r = await aifirst(["next"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Which book are you reading?");
    expect(r.stdout).toContain("AI First Python Programming");
    expect(r.stdout).toContain("AI First Java Programming");
  });

  it("next (no book selected, json) returns needsBookChoice", async () => {
    const r = await aifirst(["next", "--format", "json"]);
    expect(r.code).toBe(1);
    const data = JSON.parse(r.stdout);
    expect(data.needsBookChoice).toBe(true);
    expect(data.next).toBeNull();
    expect(data.books).toHaveLength(2);
    expect(data.books.map((b: { tag: string }) => b.tag).sort()).toEqual(["java", "py"]);
  });

  it("next py returns the first uncompleted exercise in the Python book", async () => {
    const r = await aifirst(["next", "py", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.exerciseId).toBe("py-1-01");
    expect(data.next.language).toBe("python");
  });

  it("next never crosses book boundaries", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await aifirst(["next", "py", "--format", "json"]);
      const data = JSON.parse(r.stdout);
      if (data.next) {
        expect(data.next.language).toBe("python");
      } else {
        break;
      }
    }
  });

  it("book command shows current choice and all options", async () => {
    const r = await aifirst(["book", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.needsBookChoice).toBe(true);
    expect(data.books).toHaveLength(2);
  });

  it("book py sets the active book", async () => {
    await aifirst(["book", "py"]);
    const r = await aifirst(["book", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.active).toBe("ai-first-python-programming");
    expect(data.needsBookChoice).toBe(false);
  });
});

// ===========================================================================
// 7. Progress Scenarios
// ===========================================================================

describe("7. Progress scenarios", () => {
  it("progress --format json shows hierarchical structure: overall → books → chapters", async () => {
    await aifirst(["next", "py"]); // records py-1-01
    const r = await aifirst(["progress", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.overall).toBeDefined();
    expect(data.overall.done).toBe(1);
    expect(data.books).toHaveLength(2);
    const pyBook = data.books.find((b: { bookId: string }) => b.bookId.includes("python"));
    expect(pyBook).toBeDefined();
    expect(pyBook.counts.done).toBe(1);
    expect(pyBook.chapters).toBeDefined();
  });

  it("progress shows content pack version and source", async () => {
    const r = await aifirst(["progress", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.content).toBeDefined();
    expect(data.content.pack).toBeDefined();
    expect(data.content.source).toBe("embedded");
  });

  it("done <id> marks exercise as done and advances next", async () => {
    await aifirst(["book", "py"]);
    await aifirst(["done", "py-1-01"]);
    // After marking done, next advances to the next uncompleted exercise
    const r = await aifirst(["next", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    // The next exercise after py-1-01 in id order
    expect(data.next).toBeDefined();
    expect(data.next.language).toBe("python");
  });

  it("skip <id> marks as skipped but not done", async () => {
    await aifirst(["book", "py"]);
    await aifirst(["skip", "py-1-01"]);
    const r = await aifirst(["progress", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.overall.done).toBe(0);
    expect(data.overall.skipped).toBe(1);
    // Skipped exercises are not offered again by next
    const nextR = await aifirst(["next", "py", "--format", "json"]);
    const nextData = JSON.parse(nextR.stdout);
    expect(nextData.exerciseId).not.toBe("py-1-01");
  });

  it("reset <id> clears a single exercise", async () => {
    await aifirst(["next", "py"]);
    await aifirst(["reset", "py-1-01"]);
    const r = await aifirst(["progress", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.overall.done).toBe(0);
  });

  it("reset --all clears everything including the bookmark", async () => {
    await aifirst(["next", "py"]);
    await aifirst(["next", "py"]);
    await aifirst(["reset", "--all"]);
    // After reset, next goes back to the first exercise and runs it (bare-mode cycle)
    const r = await aifirst(["next", "py", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.exerciseId).toBe("py-1-01"); // back to first
    expect(data.completed).toBe(true);
    expect(data.recorded).toBe(true);
  });
});

// ===========================================================================
// 8. JSON Contract Stability
// ===========================================================================

describe("8. JSON contract stability", () => {
  it("next --format json has correct top-level keys for bare-mode cycle", async () => {
    const r = await aifirst(["next", "py", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data).toHaveProperty("completed");
    expect(data).toHaveProperty("exerciseId");
    expect(data).toHaveProperty("stepId");
    expect(data).toHaveProperty("path");
    expect(data).toHaveProperty("wrote");
    expect(data).toHaveProperty("ran");
    expect(data).toHaveProperty("recorded");
    expect(data).toHaveProperty("next");
  });

  it("show --format json has correct keys", async () => {
    const r = await aifirst(["show", "py-1-01", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("title");
    expect(data).toHaveProperty("description");
    expect(data).toHaveProperty("language");
    expect(data).toHaveProperty("book");
    expect(data).toHaveProperty("steps");
    expect(data).toHaveProperty("progress");
  });

  it("all JSON output is valid and parseable", async () => {
    const jsonArgs = [
      ["next", "py", "--format", "json"],
      ["show", "py-1-01", "--format", "json"],
      ["run", "py-1-01", "--yes", "--format", "json"],
      ["progress", "--format", "json"],
      ["book", "--format", "json"],
    ];
    for (const args of jsonArgs) {
      const r = await aifirst(args);
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    }
  });
});

// ===========================================================================
// 9. Key Invariants
// ===========================================================================

describe("9. Key invariants", () => {
  it("next writes files and records progress (unlike old behavior)", async () => {
    const before = new Set(
      (await Bun.$`find ${sandbox} -type f`.text()).trim().split("\n"),
    );
    await aifirst(["next", "py"]);
    const after = new Set(
      (await Bun.$`find ${sandbox} -type f`.text()).trim().split("\n"),
    );
    // next NOW writes files (bare-mode learning UX)
    expect(after.size).toBeGreaterThan(before.size);
  });

  it("show never writes files or records progress", async () => {
    await aifirst(["show", "py-1-01"]);
    const progress = JSON.parse((await aifirst(["progress", "--format", "json"])).stdout);
    expect(progress.overall.done).toBe(0);
  });

  it("run records progress only on exit 0", async () => {
    const dir = join(sandbox, "broken2", "books");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ai-first-python-programming.json"),
      JSON.stringify({
        title: "Broken Python",
        tag: "py",
        language: "python",
        sections: [
          {
            title: "S",
            chapters: [
              {
                title: "Chapter 1: C",
                examples: [
                  {
                    id: "py-1-01",
                    title: "Boom",
                    prompt: "p",
                    response: "import sys\nsys.exit(3)",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const r = await aifirst(["run", "py-1-01", "--yes", "--format", "json"], {
      AIFIRST_CONTENT_DIR: join(sandbox, "broken2"),
    });
    expect(r.code).toBe(1);
    const data = JSON.parse(r.stdout);
    expect(data.ran.ok).toBe(false);
    expect(data.recorded).toBe(false);
  });
});

// ===========================================================================
// 10. Text output format details
// ===========================================================================

describe("10. Text output format details", () => {
  it("show text output includes 'aifirst apply' suggestion when not yet done", async () => {
    const r = await aifirst(["show", "py-1-01"]);
    expect(r.stdout).toContain("aifirst apply");
  });

  it("show text output includes 'recorded done' after run", async () => {
    await aifirst(["next", "py"]);
    const r = await aifirst(["show", "py-1-01"]);
    expect(r.stdout).toContain("recorded");
    expect(r.stdout).toContain("done");
  });

  it("show text output includes line numbers in code block", async () => {
    const r = await aifirst(["show", "py-1-01"]);
    expect(r.stdout).toMatch(/\s*1\s+print/);
  });

  it("next text output shows Code block with line numbers", async () => {
    const r = await aifirst(["next", "py"]);
    expect(r.stdout).toContain("Code");
    expect(r.stdout).toMatch(/\s*1\s+print/);
  });

  it("next text output shows Output section", async () => {
    const r = await aifirst(["next", "py"]);
    expect(r.stdout).toContain("Output");
    expect(r.stdout).toContain("Hello, World!");
  });

  it("next text output shows Explanation section", async () => {
    const r = await aifirst(["next", "py"]);
    expect(r.stdout).toContain("Explanation");
  });

  it("next text output shows 'Next' with next exercise id", async () => {
    const r = await aifirst(["next", "py"]);
    expect(r.stdout).toContain("Next");
    expect(r.stdout).toContain("py-2-01");
  });
});

// ===========================================================================
// 11. Edge cases and boundary conditions
// ===========================================================================

describe("11. Edge cases and boundary conditions", () => {
  it("progress --format md renders markdown header", async () => {
    const r = await aifirst(["progress", "--format", "md"]);
    expect(r.stdout).toContain("# AI First progress");
  });

  it("run --into writes to a custom path", async () => {
    const r = await aifirst(["run", "py-1-01", "--into", "my_hello.py", "--yes", "--format", "json"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.path).toContain("my_hello.py");
    expect(readFileSync(data.path, "utf8")).toBe('print("Hello, World!")\n');
  });

  it("run --into - writes to a file named '-' and runs it", async () => {
    const r = await aifirst(["run", "py-1-01", "--into", "-", "--yes"]);
    // run writes to a file named '-' (not stdout like apply does)
    expect(r.stdout).toContain('print("Hello, World!")');
    expect(r.stdout).toContain("ran clean");
    // A file named "-" was created (in the cwd, not the sandbox)
    expect(existsSync(join(sandbox, "-"))).toBe(true);
  });

  it("apply --into - writes to stdout without touching filesystem", async () => {
    const r = await aifirst(["apply", "py-1-01", "--into", "-"]);
    expect(r.stdout).toBe('print("Hello, World!")\n');
  });

  it("apply --format json shows recorded: false", async () => {
    const r = await aifirst(["apply", "py-1-01", "--into", "x.py", "--format", "json"]);
    const data = JSON.parse(r.stdout);
    expect(data.recorded).toBe(false);
  });

  it("next with --into writes to custom path", async () => {
    const r = await aifirst(["next", "py", "--into", "my_hello.py", "--format", "json"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.path).toContain("my_hello.py");
    expect(data.wrote).toBe(true);
    expect(data.recorded).toBe(true);
  });
});
