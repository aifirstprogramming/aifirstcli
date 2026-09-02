import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";

/**
 * `aifirst run` and the completion rule.
 *
 * The behaviour under test is the fix for a real failure: an assistant marked an
 * exercise done having neither written the file nor run it. Completion now means
 * the program ran, and these assert that from the outside.
 */

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const AUTHORED_EXERCISES = resolveContent().content.examples.length;

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "aifirst-run-"));
});

afterEach(() => {
  // Windows can hold the directory open briefly after a child process exits, so
  // retry rather than failing the suite on cleanup.
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

const done = async (): Promise<number> =>
  JSON.parse((await aifirst(["progress", "--all", "--format", "json"])).stdout).overall.done;

function pythonWorkspaceFile(name: string): string {
  const path = join(sandbox, "home", "aifirst", "py", name);
  mkdirSync(join(sandbox, "home", "aifirst", "py"), { recursive: true });
  return path;
}

describe("run", () => {
  it("launches Maven JavaFX projects through the configured plugin", async () => {
    const bin = join(sandbox, "bin");
    const log = join(sandbox, "maven.log");
    mkdirSync(bin, { recursive: true });
    const mvn = join(bin, process.platform === "win32" ? "mvn.cmd" : "mvn");
    writeFileSync(
      mvn,
      process.platform === "win32"
        ? `@echo %* > "${log}"\r\n`
        : `#!/bin/sh\nprintf '%s\\n' "$*" > "$AIFIRST_MVN_LOG"\n`,
    );
    if (process.platform !== "win32") chmodSync(mvn, 0o755);

    const result = await aifirst(
      ["run", "java-11-01", "--yes", "--no-timeout", "--format", "json"],
      {
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        AIFIRST_MVN_LOG: log,
      },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).ran.commands).toEqual(["mvn javafx:run"]);
    expect(readFileSync(log, "utf8").trim()).toBe("javafx:run");
  });

  it("reports missing dependencies before writing or recording anything", async () => {
    const dir = join(sandbox, "dependency-pack", "books");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ai-first-python-programming.json"),
      JSON.stringify({
        title: "Dependency Python",
        tag: "py",
        language: "python",
        sections: [{
          title: "S",
          chapters: [{
            title: "Chapter 1: C",
            examples: [{
              id: "py-1-01",
              title: "Missing Dependency",
              prompt: "p",
              response: "print('should not run')",
              dependencies: [{
                kind: "python-package",
                package: "DefinitelyMissing",
                module: "aifirst_module_that_does_not_exist",
              }],
            }],
          }],
        }],
      }),
    );

    const r = await aifirst(["run", "py-1-01", "--format", "json"], {
      AIFIRST_CONTENT_DIR: join(sandbox, "dependency-pack"),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const error = JSON.parse(r.stderr).error;
    expect(error.code).toBe("missing_dependencies");
    expect(error.details.missing[0].package).toBe("DefinitelyMissing");
    expect(error.details.installCommand).toContain("--yes");
    expect(existsSync(join(sandbox, "missing_dependency.py"))).toBe(false);
    expect(await done()).toBe(0);
  });

  it("writes the file, runs it, and records it", async () => {
    const r = await aifirst(["run", "py-1-01", "--format", "json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.wrote).toBe(true);
    expect(out.ran.ok).toBe(true);
    // Trimmed: the interpreter's line endings are the platform's business
    // (Python emits CRLF on Windows) and we report its output as captured.
    expect(out.ran.stdout.trim()).toBe("Hello, World!");
    expect(out.recorded).toBe(true);
    expect(readFileSync(out.path, "utf8")).toBe('print("Hello, World!")\n');
    expect(await done()).toBe(1);
  });

 it(
    "names a Java file after its public class and runs it",
    async () => {
      const r = await aifirst(["run", "java-1-01", "--format", "json"]);
      // Java may not be installed; handle both cases
      if (r.code === 0) {
        const out = JSON.parse(r.stdout);
        expect(out.path.endsWith("HelloWorld.java")).toBe(true);
        expect(out.ran.ok).toBe(true);
        expect(out.ran.stdout).toContain("Hello, World!");
      } else {
        // Java not installed. The file was written.
        const err = JSON.parse(r.stderr);
        expect(err.error.message).toContain("java");
      }
    },
    // `java Foo.java` compiles in memory on every run; a cold Windows runner
    // takes well over the default 5s.
    60_000,
  );

  it("feeds the authored sample to an exercise that reads input", async () => {
    const r = await aifirst(["run", "py-3-10", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.stdin).toBe("\n\n\nstop\n");
    expect(out.ran.ok).toBe(true);
    expect(out.ran.stdout).toContain("Stopped.");
    expect(out.recorded).toBe(true);
  });

  it("runs the final step of a progressive exercise", async () => {
    const r = await aifirst(["run", "py-3-01", "--format", "json"]);
    expect(JSON.parse(r.stdout).stepId).toBe("py-3-01.3");
  });

  it("can run one named step", async () => {
    const r = await aifirst(["run", "py-3-01.1", "--format", "json"]);
    expect(JSON.parse(r.stdout).stepId).toBe("py-3-01.1");
  });

  it("does not record an exercise whose program fails", async () => {
    // The headline rule. Every real exercise runs clean by design, so proving this
    // needs a pack with a deliberately failing exercise.
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

    const r = await aifirst(["run", "py-1-01", "--format", "json"], {
      AIFIRST_CONTENT_DIR: join(sandbox, "broken"),
    });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.wrote).toBe(true); // the file is still written, so they can debug it
    expect(out.ran.ok).toBe(false);
    expect(out.ran.exitCode).toBe(3);
    expect(out.recorded).toBe(false);
    expect(await done()).toBe(0);
  });

  it("refuses to replace a file whose contents differ", async () => {
    const path = pythonWorkspaceFile("hello_world.py");
    writeFileSync(path, "# my own attempt\n");
    const r = await aifirst(["run", "py-1-01"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already exists with different contents");
    expect(readFileSync(path, "utf8")).toBe("# my own attempt\n");
    expect(await done()).toBe(0);
  });

  it("proceeds when the existing file already matches", async () => {
    writeFileSync(pythonWorkspaceFile("hello_world.py"), 'print("Hello, World!")\n');
    const r = await aifirst(["run", "py-1-01", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.wrote).toBe(false);
    expect(out.ran.ok).toBe(true);
    expect(out.recorded).toBe(true);
  });

  it("keeps the original completion date when re-run", async () => {
    await aifirst(["run", "py-1-01"]);
    const first = JSON.parse((await aifirst(["progress", "--all", "--format", "json"])).stdout);
    const r = await aifirst(["run", "py-1-01", "--format", "json"]);
    // Already recorded, so nothing new is written to the ledger.
    expect(JSON.parse(r.stdout).recorded).toBe(false);
    expect(JSON.parse((await aifirst(["progress", "--all", "--format", "json"])).stdout).overall.done).toBe(
      first.overall.done,
    );
  });

  it("explains itself when the runtime is missing", async () => {
    const r = await aifirst(["run", "py-1-01"], { PATH: "/nonexistent" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not installed/);
    expect(await done()).toBe(0);
  });

  it("needs an exercise id", async () => {
    const r = await aifirst(["run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("needs an exercise id");
  });
});

describe("book scoping", () => {
  it("next asks which book before guessing", async () => {
    const r = await aifirst(["next", "--format", "json"]);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.needsBookChoice).toBe(true);
    expect(out.next).toBeNull();
    expect(out.books.map((b: { tag: string }) => b.tag).sort()).toEqual(["java", "py"]);
  });

  it("scopes next and progress to the chosen book", async () => {
    await aifirst(["book", "py"]);
    // next auto-runs in bare-mode; use show to read without running
    const s = JSON.parse((await aifirst(["show", "py-1-01", "--format", "json"])).stdout);
    expect(s.language).toBe("python");
    expect(JSON.parse((await aifirst(["progress", "--format", "json"])).stdout).overall.total).toBe(58);
  });

  it("never hands a Python reader a Java exercise", async () => {
    // The original bug: ids sort java-* first, so `next` offered Java.
    await aifirst(["book", "py"]);
    for (let i = 0; i < 5; i++) {
      const n = JSON.parse((await aifirst(["next", "--format", "json"])).stdout);
      if (!n.next) break;
      expect(n.next.id.startsWith("py-")).toBe(true);
      await aifirst(["done", n.next.id]);
    }
  });

  it("switches books on request", async () => {
    await aifirst(["book", "py"]);
    await aifirst(["book", "java"]);
    // next auto-runs; use show to read without running
    const s = JSON.parse((await aifirst(["show", "java-1-01", "--format", "json"])).stdout);
    expect(s.language).toBe("java");
  });

  // Clearing a book is one subprocess per exercise -- 86 of them for Java now that
  // chapters 4-9 are imported. That is well past bun's 5s default on a Windows
  // runner, and the test is measuring behaviour at the end of a book, not speed.
  it("congratulates at the end of a book instead of crossing into another", async () => {
    await aifirst(["book", "java"]);
    // Clear the whole Java book.
    const ids = JSON.parse((await aifirst(["list", "java", "--format", "json"])).stdout)
      .books[0].chapters.flatMap((c: { exercises: { id: string }[] }) => c.exercises.map((e) => e.id));
    for (const id of ids) await aifirst(["done", id]);

    const r = await aifirst(["next", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.complete).toBe(true);
    expect(out.next).toBeNull();
    expect(out.book.tag).toBe("java");
    // It offers the other book rather than silently serving it.
    expect(out.otherBooks.map((b: { tag: string }) => b.tag)).toContain("py");
    expect(r.code).toBe(0);
  }, 180_000);

  it("book with no argument reports the current choice", async () => {
    expect(JSON.parse((await aifirst(["book", "--format", "json"])).stdout).needsBookChoice).toBe(true);
    await aifirst(["book", "py"]);
    const out = JSON.parse((await aifirst(["book", "--format", "json"])).stdout);
    expect(out.active).toBe("ai-first-python-programming");
    expect(out.needsBookChoice).toBe(false);
  });

  it("all unscopes", async () => {
    await aifirst(["book", "all"]);
    expect(JSON.parse((await aifirst(["progress", "--format", "json"])).stdout).overall.total).toBe(AUTHORED_EXERCISES);
  });

  it("keeps the book choice when progress is reset", async () => {
    // Config is a separate file precisely so wiping progress doesn't send the
    // learner back to a setup question.
    await aifirst(["book", "py"]);
    await aifirst(["run", "py-1-01"]);
    await aifirst(["reset", "--all"]);
    expect(JSON.parse((await aifirst(["book", "--format", "json"])).stdout).active).toBe(
      "ai-first-python-programming",
    );
  });

  it("rejects an unknown book", async () => {
    const r = await aifirst(["book", "cobol"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No book matches");
  });
});
