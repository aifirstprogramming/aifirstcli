import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end: runs the real CLI as a subprocess.
 *
 * These are the tests that would catch a broken dispatch, a bad exit code, or
 * colour codes leaking into `--format json` — none of which unit tests see. Every
 * run gets a throwaway state dir and home, so no test can touch a real learner
 * log or agent config.
 */

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "aifirst-e2e-"));
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunOptions {
  cwd?: string;
  /**
   * Replace PATH. Agent detection probes PATH first, so a test that depends on
   * whether a tool is installed is otherwise non-deterministic: it would pass on
   * a developer machine with Claude Code installed and take a different branch on
   * a clean CI runner.
   */
  path?: string;
}

async function aifirst(args: string[], options: RunOptions = {}): Promise<Run> {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
    cwd: options.cwd ?? sandbox,
    env: {
      ...process.env,
      ...(options.path === undefined ? {} : { PATH: options.path }),
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

describe("--version and help", () => {
  it("prints a bare version", async () => {
    const r = await aifirst(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("shows help with no arguments", async () => {
    const r = await aifirst([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aifirst init");
  });

  it("suggests a command on a typo", async () => {
    const r = await aifirst(["progres"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("progress");
  });
});

describe("trusted replay execution", () => {
  it("runs a replay through one compact pre-approved command and records it", async () => {
    const r = await aifirst(["replay", "execute", "py-1-01", "--format", "json"]);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.exerciseId).toBe("py-1-01");
    expect(result.ok).toBe(true);
    expect(result.recorded).toBe(true);
    expect(result.files).toContain("hello.py");
    expect(result.commands).toEqual([{ index: 1, executable: "python3", exitCode: 0, matchesExpected: true }]);
    expect(readFileSync(join(sandbox, "hello.py"), "utf8")).toBe('print("Hello, World!")\n');
  });
});

describe("show", () => {
  it("prints the canonical response", async () => {
    const r = await aifirst(["show", "py-1-01"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('print("Hello, World!")');
  });

  it("emits parseable json with no ansi codes", async () => {
    const r = await aifirst(["show", "py-1-01", "--format", "json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.id).toBe("py-1-01");
    expect(parsed.steps[0].response).toBe('print("Hello, World!")');
    expect(r.stdout).not.toContain("[");
  });

  it("lists authored dependencies without checking or installing them", async () => {
    const shown = JSON.parse((await aifirst(["show", "py-10-01", "--format", "json"])).stdout);
    expect(shown.dependencies).toEqual([
      { kind: "python-package", package: "pygame", module: "pygame" },
      { kind: "python-package", package: "Pillow", module: "PIL" },
    ]);

    const listed = JSON.parse((await aifirst(["list", "py", "--chapter", "10", "--format", "json"])).stdout);
    expect(listed.books[0].chapters[0].exercises[0].dependencies).toEqual(shown.dependencies);
  });

  it("shows every step of a multi-step exercise", async () => {
    const r = await aifirst(["show", "py-3-01", "--format", "json"]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.multiStep).toBe(true);
    expect(parsed.steps).toHaveLength(3);
  });

  it("addresses a single step by id", async () => {
    const r = await aifirst(["show", "py-3-01.1", "--format", "json"]);
    expect(JSON.parse(r.stdout).steps).toHaveLength(1);
  });

  it("does not record progress", async () => {
    await aifirst(["show", "py-1-01"]);
    const r = await aifirst(["progress", "--format", "json"]);
    expect(JSON.parse(r.stdout).overall.done).toBe(0);
  });

  it("reports an unknown id as an error", async () => {
    const r = await aifirst(["show", "py-99-99"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No exercise matches");
  });

  it("reports an ambiguous prefix with candidates rather than guessing", async () => {
    const r = await aifirst(["show", "py-2", "--format", "json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error.message).toContain("matches");
  });

  it("accepts an unambiguous prefix", async () => {
    const r = await aifirst(["show", "py-1-0", "--format", "json"]);
    expect(JSON.parse(r.stdout).id).toBe("py-1-01");
  });
});

describe("dependencies", () => {
  it("checks an exercise without changing the workspace", async () => {
    const before = existsSync(join(sandbox, "level_editor.py"));
    const r = await aifirst(["dependencies", "py-10-01", "--format", "json"]);
    const result = JSON.parse(r.stdout);
    expect([0, 1]).toContain(r.code);
    expect(result.exerciseId).toBe("py-10-01");
    expect(result.dependencies.map((status: { dependency: { package: string } }) => status.dependency.package))
      .toEqual(["pygame", "Pillow"]);
    expect(existsSync(join(sandbox, "level_editor.py"))).toBe(before);
  });
});

describe("search", () => {
  it("finds an exercise from prompt text", async () => {
    const r = await aifirst(["search", "Write a Hello World app", "--language", "py", "--format", "json"]);
    expect(JSON.parse(r.stdout).match.id).toBe("py-1-01");
  });

  it("returns a null match rather than failing hard", async () => {
    const r = await aifirst(["search", "configure kubernetes ingress", "--format", "json"]);
    expect(JSON.parse(r.stdout).match).toBeNull();
    expect(r.code).toBe(1);
  });

  it("never crosses languages when one is given", async () => {
    const r = await aifirst(["search", "Write a Hello World app", "--language", "java", "--format", "json"]);
    const match = JSON.parse(r.stdout).match;
    if (match) expect(match.language).toBe("java");
  });

  it("rejects an unknown language", async () => {
    const r = await aifirst(["search", "anything", "--language", "cobol"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown language");
  });
});

describe("apply", () => {
  it("writes the response but deliberately does not record progress", async () => {
    // Writing a file is not completing an exercise. Recording here was the
    // original behaviour, and it let an assistant tick off work it never ran.
    const r = await aifirst(["apply", "py-1-01", "--into", "hello.py"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(sandbox, "hello.py"), "utf8")).toBe('print("Hello, World!")\n');

    const p = await aifirst(["progress", "--all", "--format", "json"]);
    expect(JSON.parse(p.stdout).overall.done).toBe(0);
  });

  it("refuses to overwrite existing work", async () => {
    writeFileSync(join(sandbox, "mine.py"), "# my own attempt\n");
    const r = await aifirst(["apply", "py-1-01", "--into", "mine.py"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(readFileSync(join(sandbox, "mine.py"), "utf8")).toBe("# my own attempt\n");
  });

  it("overwrites only with --force", async () => {
    writeFileSync(join(sandbox, "mine.py"), "# my own attempt\n");
    const r = await aifirst(["apply", "py-1-01", "--into", "mine.py", "--force"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(sandbox, "mine.py"), "utf8")).toBe('print("Hello, World!")\n');
  });

  it("writes to stdout with --into -", async () => {
    const r = await aifirst(["apply", "py-1-01", "--into", "-"]);
    expect(r.stdout).toBe('print("Hello, World!")\n');
    expect(existsSync(join(sandbox, "hello_world.py"))).toBe(false);
  });

  it("applies the final step of a progressive exercise", async () => {
    const r = await aifirst(["apply", "py-3-01", "--into", "price.py", "--format", "json"]);
    expect(JSON.parse(r.stdout).applied.stepId).toBe("py-3-01.3");
  });

  it("can apply a specific step", async () => {
    const r = await aifirst(["apply", "py-3-01", "--step", "1", "--into", "price.py", "--format", "json"]);
    expect(JSON.parse(r.stdout).applied.stepId).toBe("py-3-01.1");
  });

  it("rejects a step that does not exist", async () => {
    const r = await aifirst(["apply", "py-3-01", "--step", "9", "--into", "x.py"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no step 9");
  });

  it("names a Java file after its public class so javac accepts it", async () => {
    const r = await aifirst(["apply", "java-1-01"]);
    expect(r.code).toBe(0);
    // Derived from the class in the response, not from the exercise title.
    const written = r.stdout.match(/wrote (\S+\.java)/)?.[1];
    expect(written).toBeDefined();
    const source = readFileSync(written!, "utf8");
    const className = source.match(/class\s+(\w+)/)![1];
    expect(written!.endsWith(`${className}.java`)).toBe(true);
  });
});

describe("progress", () => {
  it("counts only authored exercises", async () => {
    const r = await aifirst(["progress", "--format", "json"]);
    expect(JSON.parse(r.stdout).overall.total).toBe(146);
  });

  it("does not count empty chapters toward a denominator", async () => {
    const r = await aifirst(["progress", "--format", "json"]);
    const books = JSON.parse(r.stdout).books;
    const empties = books.flatMap((b: { chapters: { empty: boolean }[] }) => b.chapters).filter((c: { empty: boolean }) => c.empty);
    expect(empties.length).toBeGreaterThan(0);
    for (const c of empties) expect((c as unknown as { counts: { total: number } }).counts.total).toBe(0);
  });

  it("renders markdown for pasting into a journal", async () => {
    const r = await aifirst(["progress", "--format", "md"]);
    expect(r.stdout).toContain("# AI First progress");
  });
});

describe("done, skip and reset", () => {
  it("marks and unmarks", async () => {
    await aifirst(["done", "py-1-01"]);
    let r = await aifirst(["progress", "--format", "json"]);
    expect(JSON.parse(r.stdout).overall.done).toBe(1);

    await aifirst(["reset", "py-1-01"]);
    r = await aifirst(["progress", "--format", "json"]);
    expect(JSON.parse(r.stdout).overall.done).toBe(0);
  });

  it("records the reporting agent", async () => {
    const r = await aifirst(["done", "py-1-01", "--via", "agent", "--agent", "codex", "--format", "json"]);
    expect(JSON.parse(r.stdout).entry).toMatchObject({ via: "agent", agent: "codex" });
  });

  it("records stable variant metadata from an agent", async () => {
    const variant = JSON.stringify({ kind: "adaptive", answers: { gameplay: "side_scroller" } });
    const r = await aifirst([
      "done", "py-9-01", "--via", "agent", "--agent", "claude",
      "--variant-json", variant, "--format", "json",
    ]);
    expect(JSON.parse(r.stdout).entry.variant).toEqual({
      kind: "adaptive",
      answers: { gameplay: "side_scroller" },
    });
    const progress = JSON.parse((await aifirst(["progress", "--all", "--format", "json"])).stdout);
    expect(progress.overall.variants).toBe(1);
    expect((await aifirst(["show", "py-9-01"])).stdout).toContain("adaptive variant");
  });

  it("rejects free-form text in variant metadata", async () => {
    const variant = JSON.stringify({ kind: "adaptive", answers: { gameplay: "a custom idea" } });
    const r = await aifirst(["done", "py-9-01", "--variant-json", variant, "--format", "json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stable question and option ids");
  });

  it("requires an agent identity for variant completion", async () => {
    const variant = JSON.stringify({ kind: "adaptive", answers: { gameplay: "side_scroller" } });
    const r = await aifirst(["done", "py-9-01", "--variant-json", variant, "--format", "json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("requires --via agent");
  });

  it("rejects an id that does not exist rather than recording a typo", async () => {
    const r = await aifirst(["done", "py-42-42"]);
    expect(r.code).toBe(1);
  });

  it("requires --all before clearing the whole log", async () => {
    await aifirst(["done", "py-1-01"]);
    const r = await aifirst(["reset"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--all");

    const after = await aifirst(["progress", "--format", "json"]);
    expect(JSON.parse(after.stdout).overall.done).toBe(1);
  });

  it("clears everything with --all", async () => {
    await aifirst(["done", "py-1-01"]);
    await aifirst(["reset", "--all"]);
    const r = await aifirst(["progress", "--format", "json"]);
    expect(JSON.parse(r.stdout).overall.done).toBe(0);
  });

  it("skips without counting as done", async () => {
    await aifirst(["skip", "py-1-01"]);
    const r = await aifirst(["progress", "--format", "json"]);
    const counts = JSON.parse(r.stdout).overall;
    expect(counts.done).toBe(0);
    expect(counts.skipped).toBe(1);
  });
});

describe("next", () => {
  it("advances past completed exercises", async () => {
    await aifirst(["book", "py"]);
    const first = JSON.parse((await aifirst(["next", "--format", "json"])).stdout).next.id;
    await aifirst(["done", first]);
    const second = JSON.parse((await aifirst(["next", "--format", "json"])).stdout).next.id;
    expect(second).not.toBe(first);
  });

  it("does not offer a skipped exercise again", async () => {
    await aifirst(["book", "py"]);
    const first = JSON.parse((await aifirst(["next", "--format", "json"])).stdout).next.id;
    await aifirst(["skip", first]);
    expect(JSON.parse((await aifirst(["next", "--format", "json"])).stdout).next.id).not.toBe(first);
  });

  it("can be scoped to one book", async () => {
    const r = await aifirst(["next", "py", "--format", "json"]);
    expect(JSON.parse(r.stdout).next.language).toBe("python");
  });
});

describe("list", () => {
  it("lists a single chapter", async () => {
    const r = await aifirst(["list", "py", "--chapter", "2", "--format", "json"]);
    const chapters = JSON.parse(r.stdout).books[0].chapters;
    expect(chapters).toHaveLength(1);
    expect(chapters[0].exercises.length).toBe(6);
  });

  it("shows empty chapters rather than hiding them", async () => {
    const r = await aifirst(["list", "py", "--format", "json"]);
    const chapters = JSON.parse(r.stdout).books[0].chapters;
    expect(chapters.some((c: { exercises: unknown[] }) => c.exercises.length === 0)).toBe(true);
  });

  it("errors on an unknown book", async () => {
    const r = await aifirst(["list", "cobol"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No book matches");
  });
});

describe("init and doctor", () => {
  it("doctor reports the built-in learner healthy without an AI integration", async () => {
    // PATH is cleared so an agent or editor installed on this machine cannot make
    // the sandbox look configured.
    const r = await aifirst(["doctor", "--format", "json"], { path: "/nonexistent" });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
    expect(JSON.parse(r.stdout).coreOk).toBe(true);
  });

  it("init refuses to write without confirmation when non-interactive", async () => {
    // Force one agent to be detected regardless of this machine's PATH: the
    // adapters treat an existing config directory as a signal. Without this the
    // test takes the "nothing installed" branch on a clean runner.
    mkdirSync(join(sandbox, "home", ".claude"), { recursive: true });

    const r = await aifirst(["init"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("--yes");
    expect(existsSync(join(sandbox, "home", ".claude", "skills", "aifirst"))).toBe(false);
  });

  it("init explains that built-in learning works when no AI tool is present", async () => {
    const r = await aifirst(["init"], { path: "/nonexistent" });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Built-in learning is ready");
    expect(existsSync(join(sandbox, "home", ".claude", "skills", "aifirst"))).toBe(false);
  });

  it("installs for an explicitly named agent and then passes doctor", async () => {
    const installed = await aifirst(["init", "--claude", "--format", "json"]);
    expect(installed.code).toBe(0);
    expect(existsSync(join(sandbox, "home", ".claude", "skills", "aifirst", "SKILL.md"))).toBe(true);

    const r = await aifirst(["doctor", "--format", "json"]);
    const claude = JSON.parse(r.stdout).agents.find((a: { key: string }) => a.key === "claude");
    expect(claude.skill.state).toBe("current");
  });

  it("skill check reports drift after the skill is tampered with", async () => {
    await aifirst(["init", "--claude", "--format", "json"]);
    const path = join(sandbox, "home", ".claude", "skills", "aifirst", "SKILL.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(/version: .*/, "version: 0.0.1"));

    const r = await aifirst(["skill", "check", "--claude", "--format", "json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).results[0].skill.state).toBe("drift");
  });

  it("skill remove leaves the learner log alone", async () => {
    await aifirst(["init", "--claude", "--format", "json"]);
    await aifirst(["done", "py-1-01"]);
    await aifirst(["skill", "remove", "--claude", "--format", "json"]);

    expect(existsSync(join(sandbox, "home", ".claude", "skills", "aifirst"))).toBe(false);
    const r = await aifirst(["progress", "--format", "json"]);
    expect(JSON.parse(r.stdout).overall.done).toBe(1);
  });
});

describe("content override", () => {
  it("prefers $AIFIRST_CONTENT_DIR over the embedded pack", async () => {
    const dir = join(sandbox, "custom", "books");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ai-first-python-programming.json"),
      JSON.stringify({
        title: "Custom Python",
        sections: [
          {
            title: "S",
            chapters: [
              {
                title: "Chapter 1: Custom",
                examples: [{ id: "py-1-01", title: "Custom", prompt: "custom prompt", response: "custom()" }],
              },
            ],
          },
        ],
      }),
    );

    const proc = Bun.spawn([process.execPath, "run", ENTRY, "show", "py-1-01", "--format", "json"], {
      cwd: sandbox,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: join(sandbox, "state"),
        AIFIRST_HOME_OVERRIDE: join(sandbox, "home"),
        AIFIRST_CONTENT_DIR: join(sandbox, "custom"),
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(JSON.parse(stdout).steps[0].response).toBe("custom()");
  });
});
