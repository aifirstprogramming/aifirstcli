import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const suite = process.platform === "win32" ? describe.skip : describe;
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const DRIVER = join(import.meta.dir, "fixtures", "native-tui-driver.py");
let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

suite("OpenTUI learning interface", () => {
  test("opens Home in the TUI and restores the terminal on Ctrl-C", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-tui-home-"));
    const state = join(root, "state");
    const home = join(root, "home");
    const scenario = join(root, "scenario.json");
    mkdirSync(state);
    mkdirSync(home);
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 20,
      actions: [
        { wait: "Which book are you reading?", down: 1, enter: true },
        { wait: "What would you like to do?", ctrlC: true },
      ],
    }));

    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", ENTRY], {
      cwd: root,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        NO_COLOR: "",
        AIFIRST_TUI: "1",
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
    expect(stdout).toContain("\x1b[?1049h");
    expect(stdout).toContain("AI First Home");
    expect(stdout).toContain("\x1b[?1049l");
  }, 40_000);

  test("opens progress and command reference as dismissible Home screens", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-tui-home-pages-"));
    const state = join(root, "state");
    const home = join(root, "home");
    const scenario = join(root, "scenario.json");
    mkdirSync(state);
    mkdirSync(home);
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 25,
      actions: [
        { wait: "Which book are you reading?", down: 1, enter: true },
        { wait: "What would you like to do?", down: 1, enter: true },
        { wait: "Enter/Esc return to Home", settleSeconds: 0.5, enter: true },
        { wait: "What would you like to do?", down: 3, enter: true },
        { wait: "Enter/Esc return to Home", settleSeconds: 0.5, escape: true },
        { wait: "What would you like to do?", ctrlC: true },
      ],
    }));

    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", ENTRY], {
      cwd: root,
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        TERM: "xterm-256color",
        NO_COLOR: "",
        AIFIRST_TUI: "1",
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
    expect(stdout).toContain("content pack 1.7.1");
    expect(stdout).toContain("target specific tools");
    expect(stdout).not.toContain("Browse books and exercises");
    expect(stdout).not.toContain("Connect an AI assistant (optional)");
  }, 40_000);

  test("uses highlighted pickers, accepts direct exercise input, and finishes without running", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-tui-learn-"));
    const state = join(root, "state");
    const home = join(root, "home");
    const scenario = join(root, "scenario.json");
    mkdirSync(state);
    mkdirSync(home);
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 30,
      actions: [
        { wait: "Which book are you reading?", down: 1, enter: true },
        { wait: "What would you like to do?", paste: "2.1", enter: true },
        { wait: "Your program is ready", down: 1, enter: true },
        { wait: "Lesson complete", down: 3, enter: true },
      ],
    }));

    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", ENTRY, "learn", "--no-animation"], {
      cwd: root,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        NO_COLOR: "",
        AIFIRST_TUI: "1",
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: home,
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
    expect(stdout).toContain("\x1b[?1049h");
    expect(stdout).toContain("Your program is ready");
    expect(stdout).toContain("Finish without running");
    expect(stdout).toContain("\x1b[?1049l");
    expect(stdout).toContain("AI First workspace:");
    const progressPath = join(state, "progress.json");
    expect(existsSync(progressPath)).toBe(true);
    const progress = JSON.parse(readFileSync(progressPath, "utf8"));
    expect(progress.exercises["py-2-01"].status).toBe("done");
  }, 70_000);
});
