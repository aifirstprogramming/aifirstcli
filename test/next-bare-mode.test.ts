/**
 * `aifirst next` in bare-mode learning UX.
 *
 * The new behaviour: `next` is the full cycle. It presents the exercise,
 * writes the canonical code, runs it, explains it, records success, and
 * advances to the next exercise. One command does everything.
 *
 * Rules:
 *  - `show` stays read-only (unchanged).
 *  - `run` stays explicit write/run/record (unchanged).
 *  - `next` writes, runs, explains, records, and advances in one call.
 *  - JSON output preserves truthful failure semantics.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "aifirst-next-bare-"));
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

function pythonWorkspaceFile(name: string): string {
  const directory = join(sandbox, "home", "aifirst", "py");
  mkdirSync(directory, { recursive: true });
  return join(directory, name);
}

describe("next bare-mode: text output", () => {
  beforeEach(async () => {
    await aifirst(["book", "py"]);
  });

  it("shows the exercise title, code, and explanation in one go", async () => {
    const r = await aifirst(["next", "--format", "text"]);
    expect(r.code).toBe(0);
    const out = r.stdout;
    expect(out).toContain("Hello, World!");
    expect(out).toContain("py-1-01");
    // codeBlock uses line-numbered output, not triple backticks
    expect(out).toContain("Code");
  });

  it("writes the file automatically", async () => {
    await aifirst(["next"]);
    const path = pythonWorkspaceFile("hello_world.py");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('print("Hello, World!")\n');
  });

  it("records the exercise as done after a successful run", async () => {
    await aifirst(["next"]);
    const progress = JSON.parse((await aifirst(["progress", "--all", "--format", "json"])).stdout);
    expect(progress.overall.done).toBe(1);
  });

  it("advances to the next exercise on the next call", async () => {
    await aifirst(["next"]);
    // First exercise done, now ask for next again
    const r = await aifirst(["next", "--format", "json"]);
    const next = JSON.parse(r.stdout);
    expect(next.next.id).not.toBe("py-1-01");
  });
});

describe("next bare-mode: JSON output", () => {
  beforeEach(async () => {
    await aifirst(["book", "py"]);
  });

  it("reports success with the correct shape", async () => {
    const r = await aifirst(["next", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.completed).toBe(true);
    expect(out.exerciseId).toBe("py-1-01");
    expect(out.wrote).toBe(true);
    expect(out.ran.ok).toBe(true);
    expect(out.recorded).toBe(true);
  });

  it("includes the path where the file was written", async () => {
    const r = await aifirst(["next", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.path).toBeDefined();
    expect(typeof out.path).toBe("string");
  });

  it("reports the next exercise id after completion", async () => {
    const r = await aifirst(["next", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.next).toBeDefined();
    expect(out.next.id).not.toBe("py-1-01");
  });
});

describe("next bare-mode: book choice", () => {
  it("asks for a book choice when none is set (JSON)", async () => {
    const r = await aifirst(["next", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.needsBookChoice).toBe(true);
    expect(out.next).toBeNull();
  });

  it("asks for a book choice when none is set (text)", async () => {
    const r = await aifirst(["next"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Which book are you reading?");
  });
});

describe("next bare-mode: failure semantics", () => {
  beforeEach(async () => {
    await aifirst(["book", "py"]);
  });

  it("does not record when the run fails", async () => {
    const dir = join(sandbox, "broken", "books");
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
                  { id: "py-1-01", title: "Boom", prompt: "p", response: "import sys\nsys.exit(3)" },
                ],
              },
            ],
          },
        ],
      }),
    );

    const r = await aifirst(["next", "--format", "json"], {
      AIFIRST_CONTENT_DIR: join(sandbox, "broken"),
    });
    const out = JSON.parse(r.stdout);
    expect(out.completed).toBe(false);
    expect(out.ran.ok).toBe(false);
    expect(out.recorded).toBe(false);
  });

  it("does not advance when the run fails", async () => {
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
                  { id: "py-1-01", title: "Boom", prompt: "p", response: "import sys\nsys.exit(3)" },
                ],
              },
            ],
          },
        ],
      }),
    );

    await aifirst(["next"], { AIFIRST_CONTENT_DIR: join(sandbox, "broken2") });
    // Next call should still return py-1-01
    const r = await aifirst(["next", "--format", "json"], {
      AIFIRST_CONTENT_DIR: join(sandbox, "broken2"),
    });
    const out = JSON.parse(r.stdout);
    expect(out.next.id).toBe("py-1-01");
  });

  it("writes the file even when the run fails", async () => {
    const dir = join(sandbox, "broken3", "books");
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
                  { id: "py-1-01", title: "Boom", prompt: "p", response: "import sys\nsys.exit(3)" },
                ],
              },
            ],
          },
        ],
      }),
    );

    // Select the book first, then run next
    await aifirst(["book", "py"], { AIFIRST_CONTENT_DIR: join(sandbox, "broken3") });
    await aifirst(["next"], { AIFIRST_CONTENT_DIR: join(sandbox, "broken3") });
    // The exercise title is "Boom" so the filename is boom.py
    const path = pythonWorkspaceFile("boom.py");
    expect(existsSync(path)).toBe(true);
  });
});

describe("next bare-mode: already-written file", () => {
  beforeEach(async () => {
    await aifirst(["book", "py"]);
  });

  it("uses the existing file if it already matches", async () => {
    writeFileSync(pythonWorkspaceFile("hello_world.py"), 'print("Hello, World!")\n');
    const r = await aifirst(["next", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.wrote).toBe(false);
    expect(out.ran.ok).toBe(true);
    expect(out.recorded).toBe(true);
  });

  it("refuses to replace a different existing file", async () => {
    writeFileSync(pythonWorkspaceFile("hello_world.py"), "# my own attempt\n");
    const r = await aifirst(["next"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("already exists with different contents");
  });
});

describe("next bare-mode: scaffold entrypoints", () => {
  it("writes the scaffold before running its declared entrypoint", async () => {
    const dir = join(sandbox, "scaffold-pack", "books");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ai-first-python-programming.json"),
      JSON.stringify({
        title: "Scaffold Python",
        tag: "py",
        language: "python",
        sections: [{
          title: "S",
          chapters: [{
            title: "Chapter 1: C",
            examples: [{
              id: "py-1-01",
              title: "Scaffold Entry",
              prompt: "p",
              response: "print('canonical')",
              scaffold: {
                entrypoint: "runner.py",
                files: [{ path: "runner.py", content: "print('scaffold ran')" }],
              },
            }],
          }],
        }],
      }),
    );
    const env = { AIFIRST_CONTENT_DIR: join(sandbox, "scaffold-pack") };
    await aifirst(["book", "py"], env);

    const result = await aifirst(["next", "--format", "json"], env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ran.stdout.replace(/\r\n/g, "\n")).toBe("scaffold ran\n");
    expect(readFileSync(pythonWorkspaceFile("runner.py"), "utf8")).toBe("print('scaffold ran')\n");
  });
});
