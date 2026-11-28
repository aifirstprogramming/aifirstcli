import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Args } from "../src/cli";
import { commandsFor, runTimeoutMs } from "../src/commands/run";
import { resolveContent } from "../src/content";
import type { ReplayStep } from "../src/content/types";
import * as learnNative from "../src/learn/native";
import { nativeReplayOperation, opensExternalWindow } from "../src/learn/native";
import { mavenJavaFxCommand } from "../src/projects";

const suite = process.platform === "win32" ? describe.skip : describe;
const DRIVER = join(import.meta.dir, "fixtures", "native-tui-driver.py");
const PROGRAM_DRIVER = join(import.meta.dir, "fixtures", "tui-program-driver.ts");
const CANCEL_DRIVER = join(import.meta.dir, "fixtures", "tui-program-cancel-driver.ts");
const INTERACTIVE_DRIVER = join(import.meta.dir, "fixtures", "tui-interactive-program-driver.ts");
let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("verification that opens a program window", () => {
  const GUIDANCE = "When the program window opens, close it to return to Learn.";
  const withDisplay = { DISPLAY: ":0" };
  const replayExecute = (id: string) => ({
    type: "command" as const,
    command: ["aifirst", "replay", "execute", id, "--format", "json"],
    expectedExitCode: 0,
  });
  const options = (...args: unknown[]) =>
    (learnNative as unknown as { verificationTaskOptions: (...a: unknown[]) => { detail?: string } })
      .verificationTaskOptions(...args);

  test("guides the reader when a compact replay ends by opening the app", () => {
    const content = resolveContent().content;
    for (const id of ["java-11-01", "java-11-02"]) {
      expect(options(replayExecute(id), content, withDisplay, "linux")).toEqual({ detail: GUIDANCE });
      expect(options(replayExecute(id), content, {}, "darwin")).toEqual({ detail: GUIDANCE });
    }
  });

  test("stays silent when headless Linux will skip the window", () => {
    const content = resolveContent().content;
    expect(options(replayExecute("java-11-02"), content, {}, "linux")).toEqual({});
  });

  test("stays silent for verification that never opens a window", () => {
    const content = resolveContent().content;
    expect(options(replayExecute("py-1-01"), content, withDisplay, "linux")).toEqual({});
    expect(options({ type: "write", path: "a.txt", content: "" }, content, withDisplay, "linux")).toEqual({});
    expect(options({ type: "command", command: ["mvn", "-q", "clean", "test"] }, content, withDisplay, "linux")).toEqual({});
  });

  test("follows the operations replay execute actually runs, not narrated events", () => {
    const launch = { type: "command", command: ["mvn", "-q", "javafx:run"], graphical: true };
    const synthetic = (replay: Record<string, unknown>) =>
      ({ steps: [{ id: "x-1-01", replay }] }) as unknown as ReturnType<typeof resolveContent>["content"];
    const eventsOnly = synthetic({ operations: [], events: [{ type: "operation", operation: launch }] });
    const inOperations = synthetic({ operations: [launch] });
    expect(options(replayExecute("x-1-01"), eventsOnly, withDisplay, "linux")).toEqual({});
    expect(options(replayExecute("x-1-01"), inOperations, withDisplay, "linux")).toEqual({ detail: GUIDANCE });
  });

  test("guides the reader for a direct graphical command", () => {
    const content = resolveContent().content;
    const graphical = { type: "command", command: ["mvn", "-q", "javafx:run"], graphical: true };
    expect(options(graphical, content, withDisplay, "linux")).toEqual({ detail: GUIDANCE });
    expect(options(graphical, content, {}, "linux")).toEqual({});
  });
});

describe("graphical exercise runs", () => {
  test("classifies pygame entrypoints as external-window programs", () => {
    const content = resolveContent().content;
    const duckling = content.steps.find((step) => step.id === "py-9-01") as ReplayStep;
    const hello = content.steps.find((step) => step.id === "py-1-01") as ReplayStep;
    expect(opensExternalWindow(duckling)).toBe(true);
    expect(opensExternalWindow(hello)).toBe(false);
  });

  test("launches Maven JavaFX projects as external-window programs", () => {
    const content = resolveContent().content;
    const pocketCfo = content.steps.find((step) => step.id === "java-11-01") as ReplayStep;
    const example = content.examples.find((candidate) => candidate.id === pocketCfo.exampleId)!;

    expect(mavenJavaFxCommand(pocketCfo)).toEqual(["mvn", "javafx:run"]);
    expect(commandsFor(example, pocketCfo, "Transaction.java")).toEqual([["mvn", "javafx:run"]]);
    expect(opensExternalWindow(pocketCfo)).toBe(true);
  });

  test("compiles a Java class that has no main method", () => {
    const content = resolveContent().content;
    const thermostat = content.steps.find((step) => step.id === "java-6-01") as ReplayStep;
    const example = content.examples.find((candidate) => candidate.id === thermostat.exampleId)!;

    expect(commandsFor(example, thermostat, "Thermostat.java")).toEqual([
      ["mvn", "-q", "-DskipTests", "compile"],
    ]);
    expect(commandsFor(
      { ...example, scaffold: undefined },
      { ...thermostat, scaffold: undefined, execution: { mode: "compile" } },
      "Thermostat.java",
    )).toEqual([
      ["javac", "-d", "out", "Thermostat.java"],
    ]);
  });

  test("the internal no-timeout run option disables the short watchdog", () => {
    const args = (flags: Map<string, string | boolean>): Args => ({ command: "run", positionals: ["py-9-01"], flags });
    expect(runTimeoutMs(args(new Map()))).toBe(30_000);
    expect(runTimeoutMs(args(new Map()), { mode: "compile" })).toBe(180_000);
    expect(runTimeoutMs(args(new Map()), {
      mode: "run",
      launch: { surface: "external" },
    })).toBeUndefined();
    expect(runTimeoutMs(args(new Map([["no-timeout", true]])))).toBeUndefined();
  });

  test("replaces captured pygame window launches with a portable compile check", () => {
    const content = resolveContent().content;
    const step = content.steps.find((candidate) => candidate.id === "py-9-01") as ReplayStep;
    const command = step.replay?.events
      ?.flatMap((event) => event.type === "operation" ? [event.operation] : [])
      .find((operation) => operation.type === "command" && operation.command.some((argument) => argument.includes("timeout 3 python3 main.py")));
    expect(command?.type).toBe("command");
    if (command?.type !== "command") return;
    const materialized = nativeReplayOperation(command, step);
    expect(materialized.type).toBe("command");
    if (materialized.type !== "command") return;
    expect(materialized.portableCommand).toEqual(["<python>", "-m", "py_compile", "main.py"]);
    expect(materialized.expectedExitCode).toBe(0);
    expect(materialized.timeoutMs).toBeUndefined();
  });
});

suite("retained graphical run status", () => {
  test("keeps the alternate-screen TUI active while the program runs", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-tui-program-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 10,
      actions: [
        { wait: "Program running in another window" },
        { wait: "PROGRAM_DONE" },
      ],
    }));

    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", PROGRAM_DRIVER], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "", AIFIRST_TUI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
    expect(stdout.match(/\x1b\[\?1049h/g)?.length).toBe(1);
    expect(stdout.match(/\x1b\[\?1049l/g)?.length).toBe(1);
    expect(stdout.indexOf("PROGRAM_DONE")).toBeLessThan(stdout.indexOf("\x1b[?1049l"));
  }, 20_000);

  test("Escape cancels a running program without leaving the TUI", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-tui-program-cancel-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 10,
      actions: [
        { wait: "Program running in another window", escape: true },
        { wait: "PROGRAM_CANCELLED" },
      ],
    }));

    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", CANCEL_DRIVER], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "", AIFIRST_TUI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
    expect(stdout.match(/\x1b\[\?1049h/g)?.length).toBe(1);
    expect(stdout.match(/\x1b\[\?1049l/g)?.length).toBe(1);
  }, 20_000);
});

suite("embedded terminal program", () => {
  test("streams output and accepts reader input without leaving the TUI", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-tui-interactive-program-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 15,
      actions: [
        { wait: "What is your name?", text: "Ada", enter: true },
        { wait: "Hello, Ada!" },
        { wait: "PROGRAM_EXIT:0" },
      ],
    }));

    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", INTERACTIVE_DRIVER], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "", AIFIRST_TUI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
    expect(stdout.match(/\x1b\[\?1049h/g)?.length).toBe(1);
    expect(stdout.match(/\x1b\[\?1049l/g)?.length).toBe(1);
    expect(stdout).toContain("What is your name?");
    expect(stdout).toContain("Hello, Ada!");
  }, 25_000);
});
