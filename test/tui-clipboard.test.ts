import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsDirectOsc52, osc52Sequence } from "../src/tui/session";

const suite = process.platform === "win32" ? describe.skip : describe;
const DRIVER = join(import.meta.dir, "fixtures", "native-tui-driver.py");
const CLIPBOARD_DRIVER = join(import.meta.dir, "fixtures", "tui-clipboard-driver.ts");

suite("OpenTUI clipboard", () => {
  test("uses tmux's native OSC52 handling instead of blocked passthrough", () => {
    expect(needsDirectOsc52({ TERM: "tmux-256color", TERM_PROGRAM: "tmux" })).toBe(true);
    expect(needsDirectOsc52({ TERM: "xterm-256color" })).toBe(false);
    expect(osc52Sequence("duck")).toBe(`\x1b]52;c;${Buffer.from("duck").toString("base64")}\x07`);
    expect(osc52Sequence("duck")).not.toContain("\x1bPtmux;");
  });

  test("writes selected text through the terminal clipboard channel", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-tui-clipboard-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 10,
      actions: [{ wait: "CLIPBOARD:true" }],
    }));

    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", CLIPBOARD_DRIVER], {
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

    try {
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
      expect(stdout).toContain("\x1b]52;");
      expect(stdout).toContain(Buffer.from("COPY_ME_TEXT").toString("base64"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
