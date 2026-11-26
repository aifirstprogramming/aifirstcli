import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownStreamBlocks, streamChunks, streamDelayMs } from "../src/tui/streaming";

const suite = process.platform === "win32" ? describe.skip : describe;
const DRIVER = join(import.meta.dir, "fixtures", "native-tui-driver.py");
const STREAM_DRIVER = join(import.meta.dir, "fixtures", "tui-stream-driver.ts");
const CODE_DRIVER = join(import.meta.dir, "fixtures", "tui-code-preview-driver.ts");
const PROMPT_DRIVER = join(import.meta.dir, "fixtures", "tui-prompt-driver.ts");
const PLAN_DRIVER = join(import.meta.dir, "fixtures", "tui-plan-stream-driver.ts");
const SCROLL_DRIVER = join(import.meta.dir, "fixtures", "tui-scroll-follow-driver.ts");

describe("TUI Markdown streaming", () => {
  test("preserves Markdown while separating immediate and animated blocks", () => {
    const markdown = "## Heading\n\nA paragraph with **formatting**.\n\n```python\nprint('hi')\n```\n";
    const blocks = markdownStreamBlocks(markdown);

    expect(blocks.map((block) => block.raw).join("")).toBe(markdown);
    expect(blocks.find((block) => block.raw.startsWith("## Heading"))?.immediate).toBe(true);
    expect(blocks.find((block) => block.raw.startsWith("A paragraph"))?.immediate).toBe(false);
    expect(blocks.find((block) => block.raw.startsWith("```python"))?.immediate).toBe(false);
  });

  test("uses lossless word-aware chunks and rate-based delays", () => {
    const source = "one two three four five six";
    const chunks = streamChunks(source, 8);

    expect(chunks.join("")).toBe(source);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 8)).toBe(true);
    expect(streamDelayMs("123456789012345678901234567", 540)).toBe(50);
  });
});

suite("TUI streaming interaction", () => {
  test("withholds PTY input for an already visible or newly queued marker", () => {
    const probe = String.raw`
import os, runpy, sys, time
may_send_input = runpy.run_path(sys.argv[1])["may_send_input"]
for seen, queued, expected in (
    (b"Ready\r\nFINAL_PLAN_MARKER", b"", False),
    (b"Ready", b"\r\nFINAL_PLAN_MARKER", False),
    (b"Ready", b"\r\nStill streaming", True),
):
    reader, writer = os.pipe()
    try:
        os.write(writer, queued)
        output = bytearray(seen)
        assert may_send_input(reader, output, "FINAL_PLAN_MARKER", time.monotonic() + 2) == expected
        assert output == seen + queued
    finally:
        os.close(reader)
        os.close(writer)
`;
    const result = Bun.spawnSync(["python3", "-I", "-B", "-c", probe, DRIVER]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("reveals the read-only prompt on a keypress and still requires Enter", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-tui-prompt-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 15,
      autoRunPrompts: false,
      actions: [
        { wait: "Builda", text: "x" },
        { wait: "PRESS ENTER TO RUN THIS PROMPT", settleSeconds: 0.4, enter: true },
        { wait: "PROMPT_RESULT:run" },
      ],
    }));
    const started = performance.now();
    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", PROMPT_DRIVER], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "", AIFIRST_TUI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    try {
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
      expect(stdout).toContain("PROMPT_RESULT:run");
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("reveals the read-only prompt on a mouse click", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-tui-prompt-click-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 15,
      autoRunPrompts: false,
      actions: [
        { wait: "Press any key or click to show the full prompt", click: { x: 12, y: 8 } },
        { wait: "PRESS ENTER TO RUN THIS PROMPT", enter: true },
        { wait: "PROMPT_RESULT:run" },
      ],
    }));
    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", PROMPT_DRIVER, "--hold-stream"], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "", AIFIRST_TUI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    try {
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
      expect(stdout).toContain("PROMPT_RESULT:run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("one ordinary key reveals the complete proposed plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-tui-plan-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 15,
      actions: [
        {
          wait: "Press any key or click to show the full plan",
          absentBeforeInput: "FINAL_PLAN_MARKER",
          text: "x",
        },
        // Both must be painted before Enter, in either order.
        { wait: ["Plan finished?", "FINAL_PLAN_MARKER"], enter: true },
        { wait: "PLAN_CHOICE:yes" },
      ],
    }));
    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", PLAN_DRIVER], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "", AIFIRST_TUI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    try {
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
      expect(stdout).toContain("FINAL_PLAN_MARKER");
      expect(stdout).toContain("PLAN_CHOICE:yes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("returns to the latest output after a menu selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-tui-scroll-follow-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 15,
      actions: [
        { wait: "Choose after scrolling", scrollUp: 12, enter: true },
        { wait: "FOLLOWED_BOTTOM:true" },
      ],
    }));
    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", SCROLL_DRIVER], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "", AIFIRST_TUI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    try {
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
      expect(stdout).toContain("FOLLOWED_BOTTOM:true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("collapses code after 40 lines and expands it with e", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-tui-code-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 15,
      actions: [
        { wait: "35 more lines", text: "e" },
        { wait: "line 75" },
        { wait: "Finished expanding?", enter: true },
      ],
    }));
    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", CODE_DRIVER], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "", AIFIRST_TUI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    try {
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
      expect(stdout).toContain("35 more lines");
      expect(stdout).toContain("line 75");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test("streams incrementally and does not leak Enter into the following picker", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-tui-stream-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 15,
      actions: [
        { wait: "First paragraph starts here.", enter: true },
        { wait: "Streaming finished?", down: 1, enter: true },
        { wait: "CHOICE:no" },
      ],
    }));

    const started = performance.now();
    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", STREAM_DRIVER], {
      cwd: root,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        NO_COLOR: "",
        AIFIRST_TUI: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const elapsed = performance.now() - started;
    const visible = stdout
      .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\|_[^\x1b]*\x1b\\|\[[0-?]*[ -/]*[@-~])/g, "")
      .replace(/\s+/g, "");

    try {
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
      expect(visible).toContain("Secondparagraphremainsanimated");
      expect(visible).toContain("CHOICE:no");
      expect(elapsed).toBeGreaterThan(1_200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
});
