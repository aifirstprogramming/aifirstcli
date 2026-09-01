import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { stripAnsi } from "../src/output";
import {
  renderTerminalMarkdown,
  terminalBlocks,
  type TerminalRenderOptions,
} from "../src/learn/terminalRenderer";

function rendered(markdown: string, options: TerminalRenderOptions = {}): string {
  return terminalBlocks(markdown, { columns: 48, color: false, ...options })
    .flatMap((block) => block.fragments)
    .map((fragment) => fragment.text)
    .join("");
}

class FakeTty extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawTransitions: boolean[] = [];
  resumed = false;
  paused = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawTransitions.push(value);
    return this;
  }

  resume(): this {
    this.resumed = true;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }
}

describe("native terminal Markdown", () => {
  test("renders headings, emphasis, inline code, lists, links, quotes, and rules", () => {
    const output = rendered([
      "## Heading",
      "",
      "**Book:** *Python* and `print()` with [docs](https://example.test).",
      "",
      "- first item",
      "- second item",
      "",
      "> quoted text",
      "",
      "---",
    ].join("\n"));

    expect(output).toContain("Heading\n");
    expect(output).toContain("Book: Python and print() with docs");
    expect(output).toContain("(https://example.test).");
    expect(output).toContain("• first item");
    expect(output).toContain("• second item");
    expect(output).toContain("│ quoted text");
    expect(output).not.toMatch(/\*\*|`print\(\)`|^##/m);
  });

  test("wraps prose and list continuations with hanging indentation", () => {
    const output = rendered("- This is a deliberately long list item that wraps cleanly in a narrow terminal.", {
      columns: 34,
    });
    const lines = output.trimEnd().split("\n");
    expect(lines[0]).toStartWith("• ");
    expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true);
    expect(lines.every((line) => Array.from(line).length <= 30)).toBe(true);
  });

  test("highlights known fenced languages inside a panel without leaking HTML", () => {
    const output = terminalBlocks("```python\nprint(\"Hello\")\n```", {
      columns: 48,
      color: true,
      charsPerSecond: 360,
    }).flatMap((block) => block.fragments).map((fragment) => fragment.text).join("");

    expect(stripAnsi(output)).toContain("╭─ python");
    expect(stripAnsi(output)).toContain('  print("Hello")');
    expect(output).toContain("\x1b[96mprint\x1b[0m");
    expect(output).not.toContain("<span");
    expect(output).not.toContain("```");
  });

  test("falls back to plaintext for unknown fence languages", () => {
    const output = rendered("```made-up\nalpha < beta\n```");
    expect(output).toContain("made-up");
    expect(output).toContain("alpha < beta");
  });

  test("ASCII and no-color output keeps structure without escape sequences", () => {
    const output = rendered("## Title\n\n```java\nclass Main {}\n```", { ascii: true });
    expect(output).toContain("+- java");
    expect(output).toContain("+-");
    expect(output).not.toContain("\x1b[");
    expect(output).not.toContain("╭");
  });
});

describe("native terminal pacing", () => {
  test("paces visible prose chunks and never splits ANSI sequences", async () => {
    const writes: string[] = [];
    const delays: number[] = [];
    await renderTerminalMarkdown("**Animated words arrive safely in chunks.**", {
      color: true,
      columns: 80,
      charsPerSecond: 100,
      chunkChars: 10,
      dumb: false,
      writer: (text) => writes.push(text),
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      stdin: new EventEmitter() as NodeJS.ReadStream,
    });

    expect(delays.length).toBeGreaterThan(1);
    expect(stripAnsi(writes.join(""))).toContain("Animated words");
    for (const write of writes) {
      expect(write.replace(/\x1b\[[0-9;]*m/g, "")).not.toContain("\x1b");
    }
  });

  test("Space reveals the current block and restores raw mode", async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    let sleeps = 0;
    await renderTerminalMarkdown("A long animated paragraph with several chunks to reveal.", {
      color: false,
      columns: 40,
      charsPerSecond: 30,
      chunkChars: 6,
      dumb: false,
      writer: (text) => writes.push(text),
      sleep: async () => {
        sleeps++;
        tty.emit("keypress", " ", { name: "space" });
      },
      stdin: tty as unknown as NodeJS.ReadStream,
    });

    expect(sleeps).toBe(1);
    expect(writes.join("")).toContain("several chunks to reveal");
    expect(tty.rawTransitions).toEqual([true, false]);
    expect(tty.listenerCount("keypress")).toBe(0);
    expect(tty.paused).toBe(true);
  });

  test("rate zero/no-animation writes immediately without sleeping", async () => {
    const delays: number[] = [];
    await renderTerminalMarkdown("Immediate output", {
      color: false,
      noAnimation: true,
      charsPerSecond: 360,
      writer: () => {},
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });
    expect(delays).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("skip input does not leak into the following menu", async () => {
    const driver = join(import.meta.dir, "fixtures", "terminal-renderer-skip-driver.py");
    const fixture = join(import.meta.dir, "fixtures", "terminal-renderer-driver.ts");
    const started = Date.now();
    const proc = Bun.spawn(["python3", driver, process.execPath, "run", fixture], {
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("intentionally long enough");
    expect(stdout).toContain("answer=2");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 12_000);
});
