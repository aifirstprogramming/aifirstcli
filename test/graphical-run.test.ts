import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Args } from "../src/cli";
import { commandsFor, runTimeoutMs } from "../src/commands/run";
import { resolveContent } from "../src/content";
import type { ReplayStep } from "../src/content/types";
import { nativeReplayOperation, opensExternalWindow } from "../src/learn/native";
import { mavenJavaFxCommand } from "../src/projects";

const suite = process.platform === "win32" ? describe.skip : describe;
const DRIVER = join(import.meta.dir, "fixtures", "native-tui-driver.py");
const PROGRAM_DRIVER = join(import.meta.dir, "fixtures", "tui-program-driver.ts");
const CANCEL_DRIVER = join(import.meta.dir, "fixtures", "tui-program-cancel-driver.ts");
let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
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

  test("the internal no-timeout run option disables the short watchdog", () => {
    const args = (flags: Map<string, string | boolean>): Args => ({ command: "run", positionals: ["py-9-01"], flags });
    expect(runTimeoutMs(args(new Map()))).toBe(30_000);
    expect(runTimeoutMs(args(new Map([["no-timeout", true]])))).toBeUndefined();
  });

  test("keeps captured pygame entrypoint smoke launches headless", () => {
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
    expect(materialized.env?.SDL_VIDEODRIVER).toBe("dummy");
    expect(materialized.env?.SDL_AUDIODRIVER).toBe("dummy");
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
