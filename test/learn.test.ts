import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const sandboxes: string[] = [];
const WINDOWS_CAPTURE_GRACE_MS = 750;

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function executable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = `${directory}/${name}`;
    if (existsSync(path)) return path;
  }
  return undefined;
}

function sandbox(): string {
  const path = mkdtempSync(join(tmpdir(), "aifirst-learn-test-"));
  mkdirSync(join(path, "bin with spaces & symbols"));
  sandboxes.push(path);
  return path;
}

type ProcessRecord = { pid: number; parentPid: number; name: string };

function timestamp(): string {
  return new Date().toISOString();
}

async function waitForPath(path: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(25);
  return existsSync(path) ? timestamp() : undefined;
}

function windowsProcessTree(rootPid: number): ProcessRecord[] {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$all = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = $_.Name } })",
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

function stopWindowsProcessTree(records: ProcessRecord[]): ProcessRecord[] {
  const pids = records.map(({ pid }) => pid).join(",");
  if (pids) {
    Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pids} -Force -ErrorAction SilentlyContinue`]);
  }
  return records;
}

function sessionState(root: string): { sessionExists: boolean; learnDirectoryExists: boolean } {
  return {
    sessionExists: existsSync(join(root, "state", "learn", "session.json")),
    learnDirectoryExists: existsSync(join(root, "state", "learn")),
  };
}

async function runLearn(root: string, status = 0, passthrough = ["--resume", "reader"]) {
  const bin = join(root, "bin with spaces & symbols");
  const capture = join(root, "capture.txt");
  const isWin = process.platform === "win32";
  const script = `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\nprintf '%s\\n' "$ANTHROPIC_BASE_URL" >> '${capture}'\nprintf '%s\\n' "$IS_DEMO" >> '${capture}'\nprintf '%s\\n' "\${ANTHROPIC_AUTH_TOKEN-unset}" >> '${capture}'\nprintf '%s\\n' "\${HOME-unset}" >> '${capture}'\nexit ${status}\n`;
  // Keep the executable shell fake for Unix PATH resolution.
  await Bun.write(join(bin, "claude.sh"), script);
  if (!isWin) {
    try {
      chmodSync(join(bin, "claude.sh"), 0o755);
    } catch {
      // chmod may throw on some platforms
    }
  }
  if (isWin) {
    const capturePath = capture.replace(/'/g, "''");
    const powershellScript = join(bin, "claude-capture.ps1");
    const scriptPath = powershellScript.replace(/'/g, "''");
    const winScript = `param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
$environment = [ordered]@{}
foreach ($name in @('ANTHROPIC_BASE_URL', 'IS_DEMO', 'ANTHROPIC_AUTH_TOKEN', 'HOME')) {
  if (Test-Path "Env:$name") { $environment[$name] = [Environment]::GetEnvironmentVariable($name) }
}
$capture = [ordered]@{ args = @($Arguments); env = $environment } | ConvertTo-Json -Compress
[IO.File]::WriteAllText('${capturePath}', $capture, [Text.UTF8Encoding]::new($false))
exit ${status}
`;
    const launcher = `@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
    await Bun.write(powershellScript, winScript);
    await Bun.write(join(bin, "claude.cmd"), launcher);
    // The command lookup checks the bare name before appending .cmd on Windows.
    await Bun.write(join(bin, "claude"), launcher);
  } else {
    // On Unix, rename to bare name so shebang works when invoked as `claude`
    try {
      await Bun.write(join(bin, "claude"), script);
      chmodSync(join(bin, "claude"), 0o755);
    } catch {
      // may throw if file exists
    }
  }
  const proc = Bun.spawn([process.execPath, "run", ENTRY, "learn", "--", ...passthrough], {
    cwd: root,
    env: {
      PATH: `${bin}${isWin ? ";" : ":"}${process.env.PATH}`,
      AIFIRST_HOME_OVERRIDE: join(root, "home"),
      AIFIRST_STATE_DIR: join(root, "state"),
      ANTHROPIC_AUTH_TOKEN: "normal-profile-token",
      CLAUDE_CODE_OAUTH_TOKEN: "normal-oauth-token",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let processExitAt: string | undefined;
  let exited = false;
  const exitedPromise = proc.exited.then(() => {
    exited = true;
    processExitAt = timestamp();
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const captureCreatedAt = await waitForPath(capture, 2_000);
  let forcedCleanupAt: string | undefined;
  let processTree: ProcessRecord[] | undefined;
  let state: ReturnType<typeof sessionState> | undefined;

  if (isWin && captureCreatedAt) {
    await Bun.sleep(WINDOWS_CAPTURE_GRACE_MS);
    if (!exited && proc.pid) {
      processTree = windowsProcessTree(proc.pid);
      state = sessionState(root);
      forcedCleanupAt = timestamp();
      const stopped = stopWindowsProcessTree(processTree);
      console.error(JSON.stringify({
        event: "learn-windows-post-capture-hang",
        captureCreatedAt,
        processExitAt,
        forcedCleanupAt,
        rootPid: proc.pid,
        processTree,
        stoppedProcessTree: stopped,
        state,
      }));
    }
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  await exitedPromise;
  return {
    code: proc.exitCode,
    stdout,
    stderr,
    capture,
    diagnostic: { captureCreatedAt, processExitAt, forcedCleanupAt, processTree, state },
  };
}

async function runLearnWithoutClaude(root: string) {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, "learn"], {
    cwd: root,
    env: {
      PATH: join(root, "bin"),
      AIFIRST_HOME_OVERRIDE: join(root, "home"),
      AIFIRST_STATE_DIR: join(root, "state"),
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode, stdout, stderr };
}

function launchDiagnostics(result: Awaited<ReturnType<typeof runLearn>>): string {
  const capture = existsSync(result.capture)
    ? readFileSync(result.capture, "utf8")
    : "<missing: PATH resolution or cmd launcher failure>";
  return [
    `exit code: ${result.code}`,
    `stdout: ${result.stdout || "<empty>"}`,
    `stderr: ${result.stderr || "<empty>"}`,
    `capture: ${capture || "<empty: PowerShell capture script failed>"}`,
    `diagnostic: ${JSON.stringify(result.diagnostic)}`,
  ].join("\n");
}

describe("learn", () => {
  it("reports a missing Claude client before it tries to launch one", async () => {
    const result = await runLearnWithoutClaude(sandbox());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Claude Code is not installed or not on PATH.");
  });

  it("launches a bare local client with a narrow environment and cleans up", async () => {
    const root = sandbox();
    const result = await runLearn(root);

    expect(result.code, launchDiagnostics(result)).toBe(0);
    expect(existsSync(result.capture), launchDiagnostics(result)).toBe(true);
    const raw = readFileSync(result.capture, "utf8");
    const launch = process.platform === "win32"
      ? JSON.parse(raw) as { args: string[]; env: Record<string, string> }
      : undefined;
    const unixArgs = raw.split("\n").slice(0, 5);
    expect((launch?.args ?? unixArgs).slice(0, 5)).toEqual([
      "--bare",
      "--settings",
      expect.stringContaining(`${process.platform === "win32" ? "\\state\\learn\\profile-" : "/state/learn/profile-"}`),
      "--resume",
      "reader",
    ]);
    const unixEnvironment = raw.split("\n").slice(5);
    expect(launch?.env.ANTHROPIC_BASE_URL ?? unixEnvironment[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(launch?.env.IS_DEMO ?? unixEnvironment[1]).toBe("1");
    expect(launch?.env.ANTHROPIC_AUTH_TOKEN ?? unixEnvironment[2]).toMatch(/^synthetic-/);
    expect(launch?.env.ANTHROPIC_AUTH_TOKEN).not.toBe("normal-profile-token");
    if (launch) expect(launch.env).not.toHaveProperty("HOME");
    else expect(unixEnvironment[3]).toBe("unset");
    expect(existsSync(join(root, "state", "learn", "session.json"))).toBe(false);
  }, 15_000);

  it.skipIf(process.platform !== "win32")("captures Windows arguments as exact PowerShell JSON", async () => {
    const root = sandbox();
    const passthrough = [
      "--resume",
      "reader",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
      "spaces & special ^ characters",
      "second ^caret & ampersand",
    ];
    const result = await runLearn(root, 0, passthrough);

    expect(result.code, launchDiagnostics(result)).toBe(0);
    expect(existsSync(result.capture), launchDiagnostics(result)).toBe(true);
    const launch = JSON.parse(readFileSync(result.capture, "utf8")) as { args: string[] };
    expect(launch.args).toEqual([
      "--bare",
      "--settings",
      expect.stringContaining("\\state\\learn\\profile-"),
      ...passthrough,
    ]);
  }, 15_000);

  it.skipIf(process.platform !== "win32")("collects the Windows process-tree root", () => {
    const root = windowsProcessTree(process.pid).find(({ pid }) => pid === process.pid);

    expect(root).toBeDefined();
    expect(root?.parentPid).toEqual(expect.any(Number));
    expect(root?.name).toEqual(expect.any(String));
  });

  it("propagates the Claude client exit status", async () => {
    const root = sandbox();
    const result = await runLearn(root, 7);
    expect(result.code, launchDiagnostics(result)).toBe(7);
  }, 15_000);
});
