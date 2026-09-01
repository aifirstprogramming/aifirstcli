import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";

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
});
