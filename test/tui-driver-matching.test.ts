import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const suite = process.platform === "win32" ? describe.skip : describe;
const DRIVER = join(import.meta.dir, "fixtures", "native-tui-driver.py");
const PROGRAM = join(import.meta.dir, "fixtures", "tui-osc-marker-program.ts");
const EXIT_PROGRAM = join(import.meta.dir, "fixtures", "tui-exit-markers-program.ts");

suite("PTY driver at child exit", () => {
  test("checks the remaining waits against output captured before the child exited", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-driver-exit-"));
    try {
      const scenario = join(root, "scenario.json");
      writeFileSync(scenario, JSON.stringify({
        columns: 80,
        rows: 24,
        timeoutSeconds: 5,
        autoRunPrompts: false,
        actions: [{ wait: "FIRST_EXIT_MARKER" }, { wait: "SECOND_EXIT_MARKER" }],
      }));
      const proc = Bun.spawn(["python3", "-B", DRIVER, scenario, process.execPath, "run", EXIT_PROGRAM], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      expect(proc.exitCode, stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("still fails when a wait never appears before the child exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-driver-exit-missing-"));
    try {
      const scenario = join(root, "scenario.json");
      writeFileSync(scenario, JSON.stringify({
        columns: 80,
        rows: 24,
        timeoutSeconds: 5,
        autoRunPrompts: false,
        actions: [{ wait: "FIRST_EXIT_MARKER" }, { wait: "NEVER_PRINTED_MARKER" }],
      }));
      const started = performance.now();
      const proc = Bun.spawn(["python3", "-B", DRIVER, scenario, process.execPath, "run", EXIT_PROGRAM], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      expect(proc.exitCode).toBe(2);
      expect(stderr).toContain('"pendingWait": "NEVER_PRINTED_MARKER"');
      // It stops at the child's exit instead of spinning until the deadline.
      expect(performance.now() - started).toBeLessThan(4_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

suite("PTY driver escape handling", () => {
  for (const mode of ["st", "bel"] as const) {
    test(`keeps text between an ESC-backslash OSC and a later ${mode === "st" ? "ESC-backslash" : "BEL"} OSC`, async () => {
      const root = mkdtempSync(join(tmpdir(), "aifirst-driver-osc-"));
      try {
        const scenario = join(root, "scenario.json");
        writeFileSync(scenario, JSON.stringify({
          columns: 80,
          rows: 24,
          timeoutSeconds: 5,
          autoRunPrompts: false,
          actions: [{ wait: "DRIVER_MARKER_VISIBLE" }],
        }));
        const proc = Bun.spawn(["python3", "-B", DRIVER, scenario, process.execPath, "run", PROGRAM, mode], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        await proc.exited;
        expect(proc.exitCode, stderr).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 20_000);
  }
});
