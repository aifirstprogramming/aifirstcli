import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const sandboxes: string[] = [];

afterEach(() => {
  const retry = process.platform === "win32" ? { maxRetries: 10, retryDelay: 100 } : {};
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true, ...retry });
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
  mkdirSync(join(path, "bin"));
  sandboxes.push(path);
  return path;
}

async function runLearn(root: string, status = 0, passthrough = ["--resume", "reader"]) {
  const bin = join(root, "bin");
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
foreach ($name in @('ANTHROPIC_BASE_URL', 'IS_DEMO', 'ANTHROPIC_AUTH_TOKEN', 'HOME', 'PSModulePath')) {
  if (Test-Path "Env:$name") { $environment[$name] = [Environment]::GetEnvironmentVariable($name) }
}
$capture = [ordered]@{ args = @($Arguments); env = $environment } | ConvertTo-Json -Compress
[IO.File]::WriteAllText('${capturePath}', $capture, [Text.UTF8Encoding]::new($false))
exit ${status}
`;
    const launcher = `@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" %*\r\n`;
    await Bun.write(powershellScript, winScript);
    await Bun.write(join(bin, "claude.cmd"), launcher);
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
      // PowerShell needs its module metadata at the nested CLI boundary on Windows.
      ...(isWin && process.env.PSModulePath ? { PSModulePath: process.env.PSModulePath } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode, stdout, stderr, capture };
}

describe("learn", () => {
  it("launches a bare local client with a narrow environment and cleans up", async () => {
    const root = sandbox();
    const result = await runLearn(root);

    expect(result.code).toBe(0);
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
    if (launch) {
      expect(launch.env).not.toHaveProperty("HOME");
      expect(launch.env.PSModulePath).toBeDefined();
    }
    else expect(unixEnvironment[3]).toBe("unset");
    expect(existsSync(join(root, "state", "learn", "session.json"))).toBe(false);
  });

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
    ];
    const result = await runLearn(root, 0, passthrough);

    expect(result.code).toBe(0);
    const launch = JSON.parse(readFileSync(result.capture, "utf8")) as { args: string[] };
    expect(launch.args).toEqual([
      "--bare",
      "--settings",
      expect.stringContaining("\\state\\learn\\profile-"),
      ...passthrough,
    ]);
  });

  it("propagates the Claude client exit status", async () => {
    const root = sandbox();
    const result = await runLearn(root, 7);
    expect(result.code).toBe(7);
  });
});
