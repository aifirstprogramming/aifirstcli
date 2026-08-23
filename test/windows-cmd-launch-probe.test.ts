import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxes: string[] = [];

type ProbeResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  argv: string[] | null;
};

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "aifirst-windows-cmd-probe-"));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, "\\\"")}"`;
}

async function collectNodeVerbatim(
  root: string,
  command: string,
  commandArgs: string[],
): Promise<ProbeResult> {
  const capture = join(root, "capture.json");
  return await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      env: { ...process.env, CAPTURE_PATH: capture },
      shell: false,
      windowsVerbatimArguments: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status) => resolve({
      status,
      stdout,
      stderr,
      argv: existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")) as string[] : null,
    }));
  });
}

async function writeFixture(root: string): Promise<string> {
  const fixtureDir = join(root, "fixture with spaces & ampersand");
  const fixture = join(fixtureDir, "capture arguments.cmd");
  const script = join(fixtureDir, "capture arguments.ps1");

  mkdirSync(fixtureDir);
  await Bun.write(script, `param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
[IO.File]::WriteAllText($env:CAPTURE_PATH, ($Arguments | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
[Console]::Out.WriteLine('fixture stdout')
[Console]::Error.WriteLine('fixture stderr')
`);
  await Bun.write(fixture, `@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  return fixture;
}

describe.skipIf(process.platform !== "win32")("Windows cmd launcher probe", () => {
  it("preserves exact arguments and streams through the verbatim cmd boundary", async () => {
    const root = sandbox();
    const expected = ["argv with spaces", "argv & ampersand ^ caret"];
    const fixture = await writeFixture(root);
    const commandLine = `"${quoteForCmd(fixture)} ${expected.map(quoteForCmd).join(" ")}"`;
    const result = await collectNodeVerbatim(
      root,
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", commandLine],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fixture stdout");
    expect(result.stderr).toContain("fixture stderr");
    expect(result.argv).toEqual(expected);
  });
});
