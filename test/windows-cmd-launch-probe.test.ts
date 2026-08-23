import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ProbeResult = {
  name: string;
  status: number | null;
  error?: string;
  stdout: string;
  stderr: string;
  argv: string[] | null;
};

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "aifirst-windows-cmd-probe-"));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function quoteForCmd(value: string): string {
  return `"${value.replace(/\^/g, "^^").replace(/&/g, "^&").replace(/"/g, "\\\"")}"`;
}

async function collect(name: string, root: string, command: string[], optionsObject = false): Promise<ProbeResult> {
  const capture = join(root, `${name}.json`);
  const options = {
    env: { ...process.env, CAPTURE_PATH: capture },
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  };
  try {
    const child = optionsObject
      ? Bun.spawn({ cmd: command, ...options })
      : Bun.spawn(command, options);
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return {
      name,
      status: child.exitCode,
      stdout,
      stderr,
      argv: existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")) as string[] : null,
    };
  } catch (error) {
    return {
      name,
      status: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stdout: "",
      stderr: "",
      argv: existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")) as string[] : null,
    };
  }
}

function diagnostics(results: ProbeResult[]): string {
  return JSON.stringify(results, null, 2);
}

describe.skipIf(process.platform !== "win32")("Windows cmd launcher probe", () => {
  it("distinguishes Bun launch candidates with spaces and cmd metacharacters", async () => {
    const root = sandbox();
    const fixtureDir = join(root, "fixture with spaces & ampersand");
    const fixture = join(fixtureDir, "capture arguments.cmd");
    const script = join(fixtureDir, "capture arguments.ps1");
    const expected = ["argv with spaces", "argv & ampersand ^ caret"];

    mkdirSync(fixtureDir);
    await Bun.write(script, `param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)\n[IO.File]::WriteAllText($env:CAPTURE_PATH, ($Arguments | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))\n[Console]::Out.WriteLine('fixture stdout')\n[Console]::Error.WriteLine('fixture stderr')\n`);
    await Bun.write(fixture, `@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" %*\r\nexit /b %ERRORLEVEL%\r\n`);

    const commandLine = `${quoteForCmd(fixture)} ${expected.map(quoteForCmd).join(" ")}`;
    const results = [
      await collect("direct-bun-spawn", root, [fixture, ...expected]),
      await collect("cmd-exe-string", root, [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", commandLine]),
      await collect("bun-options-cmd", root, [fixture, ...expected], true),
    ];
    const report = diagnostics(results);
    console.info(`Windows cmd launcher probe:\n${report}`);

    expect(results[0]?.status, report).toBeNull();
    expect(results[0]?.error, report).toContain("EINVAL");

    const passing = results.filter((result) => (
      result.status === 0
      && result.stdout.includes("fixture stdout")
      && result.stderr.includes("fixture stderr")
      && JSON.stringify(result.argv) === JSON.stringify(expected)
    ));
    expect(passing.map((result) => result.name), report).not.toEqual([]);
  });
});
