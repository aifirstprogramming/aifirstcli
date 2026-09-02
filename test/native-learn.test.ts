import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";
import { editDiff, exerciseIntroduction, replayOperationFailed } from "../src/learn/native";

const suite = process.platform === "win32" ? describe.skip : describe;
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const DRIVER = join(import.meta.dir, "fixtures", "native-learn-driver.py");
let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

suite("built-in learning", () => {
  test("completes the first exercise without any AI tool", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-learn-"));
    const state = join(root, "state");
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const book = resolveContent().content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: book.id,
      workspaces: { py: workspace },
    }));
    const proc = Bun.spawn([
      "python3",
      DRIVER,
      process.execPath,
      "run",
      ENTRY,
      "learn",
      "--plain",
    ], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: home,
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("AI First learner");
    expect(stdout).toContain("Hello, World!");
    expect(existsSync(join(workspace, "hello.py"))).toBe(true);
    const progress = JSON.parse(readFileSync(join(state, "progress.json"), "utf8"));
    expect(progress.exercises["py-1-01"].status).toBe("done");
  }, 35_000);

  test("shows canonical code and concise output for command-backed replays", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-code-"));
    const state = join(root, "state");
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const book = resolveContent().content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: book.id,
      workspaces: { py: workspace },
    }));
    writeFileSync(join(state, "progress.json"), JSON.stringify({
      version: 1,
      exercises: {
        "py-1-01": {
          status: "done",
          at: "2026-01-01T00:00:00.000Z",
          firstAt: "2026-01-01T00:00:00.000Z",
          via: "self",
        },
      },
    }));

    const proc = Bun.spawn([
      "python3",
      DRIVER,
      process.execPath,
      "run",
      ENTRY,
      "learn",
      "--plain",
    ], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: home,
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("Code");
    expect(stdout).toContain("apples = 5");
    expect(stdout).toContain('print("Bananas:", bananas)');
    expect(stdout).toContain("Output");
    expect(stdout).toContain("Apples: 5");
    expect(stdout).not.toContain('"exerciseId": "py-2-01"');
    expect(existsSync(join(workspace, "basket_of_fruits.py"))).toBe(true);
  }, 35_000);

  test("runs selected-book shorthand directly and moves the bookmark", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-shorthand-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const book = resolveContent().content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: book.id,
      workspaces: { py: workspace },
    }));
    writeFileSync(join(state, "progress.json"), JSON.stringify({
      version: 1,
      exercises: {},
      position: "py-7-01",
    }));

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: join(root, "home"),
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["2.1", "run", "exit"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("py-2-01");
    expect(existsSync(join(workspace, "basket_of_fruits.py"))).toBe(true);
    const progress = JSON.parse(readFileSync(join(state, "progress.json"), "utf8"));
    expect(progress.position).toBe("py-2-01");
    expect(progress.exercises["py-2-01"].status).toBe("done");
  }, 35_000);

  test("drills from progress into a chapter and runs the selected exercise", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-progress-menu-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const book = resolveContent().content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: book.id,
      workspaces: { py: workspace },
    }));

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: join(root, "home"),
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["4", "2", "py-2-01", "run", "exit"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("AI First Python Programming progress");
    expect(stdout).toContain("Chapter 2: Core Concepts");
    expect(existsSync(join(workspace, "basket_of_fruits.py"))).toBe(true);
  }, 35_000);

  test("reads an arbitrary exercise without writing or completing it", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-read-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const book = resolveContent().content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: book.id,
      workspaces: { py: workspace },
    }));

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: join(root, "home"),
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["3", "2", "py-2-01", "6"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("Basket of Fruits");
    expect(stdout).toContain("apples = 5");
    expect(existsSync(join(workspace, "basket_of_fruits.py"))).toBe(false);
    const progress = JSON.parse(readFileSync(join(state, "progress.json"), "utf8"));
    expect(progress.position).toBe("py-2-01");
    expect(progress.exercises).toEqual({});
  }, 35_000);

  test("changes books and activates the remembered workspace without restarting", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-change-book-"));
    const state = join(root, "state");
    const pythonWorkspace = join(root, "python-workspace");
    const home = join(root, "home");
    mkdirSync(state, { recursive: true });
    mkdirSync(pythonWorkspace, { recursive: true });
    const content = resolveContent().content;
    const python = content.books.find((candidate) => candidate.tag === "py")!;
    const java = content.books.find((candidate) => candidate.tag === "java")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: python.id,
      workspaces: { py: pythonWorkspace },
    }));

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: home,
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["5", "java", "6"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("AI First Java Programming");
    const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
    expect(config.book).toBe(java.id);
    expect(config.workspaces.java).toBe(join(home, "aifirst", "java"));
    expect(existsSync(config.workspaces.java)).toBe(true);
  }, 35_000);

  test("accepts a book tag at the main menu before resolving shorthand", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-book-tag-"));
    const state = join(root, "state");
    const javaWorkspace = join(root, "java-workspace");
    const home = join(root, "home");
    mkdirSync(state, { recursive: true });
    mkdirSync(javaWorkspace, { recursive: true });
    const content = resolveContent().content;
    const java = content.books.find((candidate) => candidate.tag === "java")!;
    const python = content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: java.id,
      workspaces: { java: javaWorkspace },
    }));

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: home,
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["py", "2.1", "run", "exit"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).not.toContain("Choose the exercise matching py");
    expect(stdout).toContain("py-2-01");
    const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
    expect(config.book).toBe(python.id);
    expect(existsSync(join(config.workspaces.py, "basket_of_fruits.py"))).toBe(true);
  }, 35_000);

  test("uses a full id to cross books and activate the owning workspace", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-cross-book-id-"));
    const state = join(root, "state");
    const javaWorkspace = join(root, "java-workspace");
    const home = join(root, "home");
    mkdirSync(state, { recursive: true });
    mkdirSync(javaWorkspace, { recursive: true });
    const content = resolveContent().content;
    const java = content.books.find((candidate) => candidate.tag === "java")!;
    const python = content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: java.id,
      workspaces: { java: javaWorkspace },
    }));

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: home,
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["py-2-01", "run", "exit"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("py-2-01");
    const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
    expect(config.book).toBe(python.id);
    expect(existsSync(join(config.workspaces.py, "basket_of_fruits.py"))).toBe(true);
  }, 35_000);

  test("does not truncate decimal shorthand into a numbered search result", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-decimal-picker-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const book = resolveContent().content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: book.id,
      workspaces: { py: workspace },
    }));

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: join(root, "home"),
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["Basket of Fruits", "2.1", "1", "run", "exit"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("Enter 1-2");
    expect(existsSync(join(workspace, "basket_of_fruits.py"))).toBe(true);
  }, 35_000);

  test("never carries a captured force flag into a learner-owned file", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-owned-file-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const book = resolveContent().content.books.find((candidate) => candidate.tag === "py")!;
    const learnerCode = "print('my own work')\n";
    const learnerFile = join(workspace, "basket_of_fruits.py");
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: book.id,
      workspaces: { py: workspace },
    }));
    writeFileSync(learnerFile, learnerCode);

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: join(root, "home"),
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["2.1", "2", "6"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout.replace(/\s+/g, "")).toContain("alreadyexistswithdifferentcontents");
    expect(stdout).toContain("Lesson paused");
    expect(readFileSync(learnerFile, "utf8")).toBe(learnerCode);
    const progress = JSON.parse(readFileSync(join(state, "progress.json"), "utf8"));
    expect(progress.exercises).toEqual({});
  }, 35_000);

  test("asks the learner to run the finished program before completion", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-finished-run-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const book = resolveContent().content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: book.id,
      workspaces: { py: workspace },
    }));

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: join(root, "home"),
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["1", "run", "exit"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("Your program is ready");
    expect(stdout).toContain("Run the program");
    expect(stdout).toContain("Running py-1-01");
  }, 35_000);

  test("finishes and records a lesson when the learner skips the final run", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-finish-without-run-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const book = resolveContent().content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: book.id,
      workspaces: { py: workspace },
    }));

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: join(root, "home"),
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["1", "finish", "exit"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("The final run was skipped");
    expect(stdout).not.toContain("  Output\r\n");
    const progress = JSON.parse(readFileSync(join(state, "progress.json"), "utf8"));
    expect(progress.exercises["py-1-01"].status).toBe("done");
  }, 35_000);

  test("keeps navigation available after every exercise is handled", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-native-complete-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(state, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const content = resolveContent().content;
    const book = content.books.find((candidate) => candidate.tag === "py")!;
    writeFileSync(join(state, "config.json"), JSON.stringify({
      version: 1,
      book: book.id,
      workspaces: { py: workspace },
    }));
    writeFileSync(join(state, "progress.json"), JSON.stringify({
      version: 1,
      exercises: Object.fromEntries(
        content.examples
          .filter((example) => example.bookId === book.id)
          .map((example) => [example.id, {
            status: "done",
            at: "2026-01-01T00:00:00.000Z",
            via: "self",
          }]),
      ),
    }));

    const proc = Bun.spawn(["python3", DRIVER, process.execPath, "run", ENTRY, "learn", "--plain"], {
      cwd: root,
      env: {
        ...process.env,
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: join(root, "home"),
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(["5"]),
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

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("Every available exercise is handled");
    expect(stdout).toContain("Browse chapters and run an exercise");
    expect(stdout).toContain("View progress");
  }, 35_000);
});

describe("native replay result classification", () => {
  test("allows harmless stderr when the captured exit code matches", () => {
    const operation = {
      type: "command" as const,
      command: ["python3", "smoke.py"],
      expectedExitCode: 0,
      expectedStderr: "",
    };
    const result = {
      files: [],
      ok: false,
      text: "ALSA warning\nexit code 0",
      command: {
        command: operation.command,
        exitCode: 0,
        stdout: "OK\n",
        stderr: "ALSA warning\n",
        matchesExpected: false,
      },
    };
    expect(replayOperationFailed(operation, result)).toBe(false);
  });

  test("still fails commands whose exit code differs from the capture", () => {
    const operation = { type: "command" as const, command: ["false"], expectedExitCode: 1 };
    const result = {
      files: [],
      ok: false,
      text: "exit code 0",
      command: {
        command: operation.command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        matchesExpected: false,
      },
    };
    expect(replayOperationFailed(operation, result)).toBe(true);
  });

  test("introduces an exercise before its replay operations", () => {
    const content = resolveContent().content;
    const example = content.examples.find((candidate) => candidate.id === "py-9-02")!;
    const step = example.steps.at(-1)!;
    const introduction = exerciseIntroduction(example, step);
    expect(introduction).toContain("py-9-02: Add a Fox Enemy");
    expect(introduction).toContain(example.chapterTitle);
    expect(introduction).toContain(step.prompt);
  });

  test("renders a condensed unified diff instead of the full edited file", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const after = [...before];
    after[9] = "line 10 changed";
    const rendered = editDiff("example.py", before.join("\n"), after.join("\n"));
    expect(rendered).toContain("--- a/example.py");
    expect(rendered).toContain("+++ b/example.py");
    expect(rendered).toContain("-line 10");
    expect(rendered).toContain("+line 10 changed");
    expect(rendered).toContain("@@");
    expect(rendered).not.toContain(" line 1\n");
    expect(rendered).not.toContain(" line 20\n");
  });
});
