import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WATCHDOG_MS = 5_000;
const POST_KILL_SETTLE_MS = 2_000;
const sandboxes: string[] = [];

type ProcessRecord = { pid: number; parentPid: number; name: string };
type MatrixResult = {
  name: string;
  durationMs: number;
  exited: boolean;
  code: number | null;
  captured: boolean;
  argvMatches: boolean;
  processNames: string[];
};

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "aifirst-windows-env-probe-"));
  sandboxes.push(root);
  return root;
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, "\\\"")}"`;
}

function windowsProcessTree(rootPid: number): ProcessRecord[] {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$all = @((Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = $_.Name } }))",
    `$pending = @(${rootPid})`,
    "$seen = @{}",
    "while ($pending.Count -gt 0) { $currentProcessId = [int]$pending[0]; $pending = @($pending | Select-Object -Skip 1); if ($seen.ContainsKey($currentProcessId)) { continue }; $seen[$currentProcessId] = $true; $pending += @($all | Where-Object { $_.parentPid -eq $currentProcessId } | ForEach-Object { $_.pid }) }",
    "$all | Where-Object { $seen.ContainsKey($_.pid) } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 || !result.stdout.byteLength) return [];
  const records = JSON.parse(new TextDecoder().decode(result.stdout)) as ProcessRecord | ProcessRecord[];
  return (Array.isArray(records) ? records : [records]).map(({ pid, parentPid, name }) => ({ pid, parentPid, name }));
}

function stopWindowsProcessTree(records: ProcessRecord[]): void {
  const pids = records.map(({ pid }) => pid).join(",");
  if (pids) {
    Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pids} -Force -ErrorAction SilentlyContinue`]);
  }
}

function windowsValue(name: string): string | undefined {
  return Object.entries(process.env).find(([envName]) => envName.toLowerCase() === name.toLowerCase())?.[1];
}

function narrowEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC"]) {
    const value = windowsValue(name);
    if (value) env[name] = value;
  }
  return env;
}

async function writeFixture(root: string): Promise<string> {
  const fixtureDir = join(root, "fixture with spaces & ampersand");
  const fixture = join(fixtureDir, "capture arguments.cmd");
  const script = join(fixtureDir, "capture arguments.ps1");
  mkdirSync(fixtureDir);
  await Bun.write(script, `param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
[IO.File]::WriteAllText($env:CAPTURE_PATH, ($Arguments | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
`);
  await Bun.write(fixture, `@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  return fixture;
}

function runCandidate(name: string, root: string, command: string, argv: string[], expectedArgv: string[], env: Record<string, string>): Promise<MatrixResult> {
  const capture = join(root, `${name}.json`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      env: { ...env, CAPTURE_PATH: capture },
      shell: false,
      windowsVerbatimArguments: true,
    });
    let finished = false;
    let watchdogFired = false;
    let resolveRootExit: () => void;
    const rootExited = new Promise<void>((resolveRoot) => {
      resolveRootExit = resolveRoot;
    });
    const finish = (code: number | null, processNames: string[] = []) => {
      if (finished) return;
      finished = true;
      const captured = existsSync(capture);
      let argvMatches = false;
      if (captured) {
        try {
          argvMatches = JSON.stringify(JSON.parse(readFileSync(capture, "utf8")) as string[]) === JSON.stringify(expectedArgv);
        } catch {
          // A malformed capture remains a failed candidate without exposing its contents.
        }
      }
      resolve({ name, durationMs: Date.now() - started, exited: code !== null, code, captured, argvMatches, processNames });
    };
    const watchdog = setTimeout(async () => {
      watchdogFired = true;
      const records = child.pid ? windowsProcessTree(child.pid) : [];
      stopWindowsProcessTree(records);

      // Wait briefly for the candidate root so sandbox cleanup cannot race it.
      await Promise.race([rootExited, Bun.sleep(POST_KILL_SETTLE_MS)]);
      finish(null, records.map(({ name: processName }) => processName).sort());
    }, WATCHDOG_MS);
    child.once("error", () => {
      clearTimeout(watchdog);
      finish(null);
    });
    child.once("exit", (code) => {
      resolveRootExit();
      clearTimeout(watchdog);
      if (!watchdogFired) finish(code);
    });
  });
}

describe.skipIf(process.platform !== "win32")("Windows narrow environment matrix", () => {
  it("probes the minimum PowerShell initialization boundary", async () => {
    const root = sandbox();
    const fixture = await writeFixture(root);
    const expected = ["argv with spaces", "argv & ampersand ^ caret"];
    const verbatimCommand = `"${quoteForCmd(fixture)} ${expected.map(quoteForCmd).join(" ")}"`;
    const command = windowsValue("ComSpec") ?? "cmd.exe";
    const argvToCmd = ["/d", "/s", "/c", verbatimCommand];
    const base = narrowEnvironment();
    const b: Record<string, string> = { ...base };
    for (const name of ["TEMP", "TMP"]) {
      const value = windowsValue(name);
      if (value) b[name] = value;
    }
    const profile = join(root, "synthetic-profile");
    const c: Record<string, string> = {
      ...b,
      USERPROFILE: join(profile, "user"),
      APPDATA: join(profile, "appdata"),
      LOCALAPPDATA: join(profile, "localappdata"),
    };
    for (const directory of Object.values(c)) {
      if (directory.startsWith(profile)) mkdirSync(directory, { recursive: true });
    }
    const dPathext = { ...c };
    const pathext = windowsValue("PATHEXT");
    if (pathext) dPathext.PATHEXT = pathext;
    const dPsModulePath = { ...c };
    const psModulePath = windowsValue("PSModulePath");
    if (psModulePath) dPsModulePath.PSModulePath = psModulePath;
    const dBoth = { ...dPathext, ...dPsModulePath };

    const isValid = (result: MatrixResult): boolean => result.exited && result.code === 0 && result.captured && result.argvMatches;
    const results: MatrixResult[] = [];
    results.push(await runCandidate("A", root, command, argvToCmd, expected, base));
    results.push(await runCandidate("B", root, command, argvToCmd, expected, b));
    results.push(await runCandidate("C", root, command, argvToCmd, expected, c));
    if (!results.some(isValid)) {
      results.push(await runCandidate("D-PATHEXT", root, command, argvToCmd, expected, dPathext));
      results.push(await runCandidate("D-PSMODULEPATH", root, command, argvToCmd, expected, dPsModulePath));
      if (!results.slice(-2).some(isValid)) {
        results.push(await runCandidate("D-BOTH", root, command, argvToCmd, expected, dBoth));
      }
    }

    console.info(`Windows narrow environment matrix:\n${JSON.stringify(results)}`);
    expect(results.map((result) => result.name).slice(0, 3)).toEqual(["A", "B", "C"]);
    expect(results.some(isValid)).toBe(true);
    for (const result of results.filter((result) => result.exited && result.code === 0)) {
      expect(result.captured).toBe(true);
      expect(result.argvMatches).toBe(true);
    }
  }, 30_000);
});
