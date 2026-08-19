import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const path = mkdtempSync(join(tmpdir(), "aifirst-learn-test-"));
  mkdirSync(join(path, "bin"));
  sandboxes.push(path);
  return path;
}

async function runLearn(root: string, status = 0) {
  const bin = join(root, "bin");
  const capture = join(root, "capture.txt");
  const isWin = process.platform === "win32";
  const script = `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\nprintf '%s\\n' "$ANTHROPIC_BASE_URL" >> '${capture}'\nprintf '%s\\n' "$IS_DEMO" >> '${capture}'\nprintf '%s\\n' "\${ANTHROPIC_AUTH_TOKEN-unset}" >> '${capture}'\nprintf '%s\\n' "\${HOME-unset}" >> '${capture}'\nexit ${status}\n`;
  // Write the shebang script as `claude` (executable on Unix) or `claude.sh` (for Windows .cmd wrapper)
  Bun.write(join(bin, "claude.sh"), script);
  if (!isWin) {
    try {
      chmodSync(join(bin, "claude.sh"), 0o755);
    } catch {
      // chmod may throw on some platforms
    }
  }
  // On Windows, write a .cmd wrapper using Windows-native commands (no sh needed)
    if (isWin) {
      const winScript = `@echo off\r\nif "%~1"=="" goto env\r\necho %~1 > "${capture}"\r\nshift /1\r\n:loop\r\nif "%~1"=="" goto env\r\necho %~1 >> "${capture}"\r\nshift /1\r\ngoto loop\r\n:env\r\necho %ANTHROPIC_BASE_URL% >> "${capture}"\r\necho %IS_DEMO% >> "${capture}"\r\necho %ANTHROPIC_AUTH_TOKEN% >> "${capture}"\r\necho %HOME% >> "${capture}"\r\nexit /b ${status}\r\n`;
      Bun.write(join(bin, "claude.cmd"), winScript);
      // Also write bare 'claude' so executable() finds it (Windows spawn needs exact path)
      Bun.write(join(bin, "claude"), winScript);
  } else {
    // On Unix, rename to bare name so shebang works when invoked as `claude`
    try {
      Bun.write(join(bin, "claude"), script);
      chmodSync(join(bin, "claude"), 0o755);
    } catch {
      // may throw if file exists
    }
  }
  const proc = Bun.spawn([process.execPath, "run", ENTRY, "learn", "--", "--resume", "reader"], {
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
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode, stdout, stderr, capture };
}

describe("learn", () => {
  it("launches a bare local client with a narrow environment and cleans up", async () => {
    const root = sandbox();
    const result = await runLearn(root);

    expect(result.code).toBe(0);
    const launch = readFileSync(result.capture, "utf8").split("\n");
    expect(launch.slice(0, 5)).toEqual(["--bare", "--settings", expect.stringContaining("/state/learn/profile-"), "--resume", "reader"]);
    expect(launch[5]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(launch[6]).toBe("1");
    expect(launch[7]).toMatch(/^synthetic-/);
    expect(launch[8]).toBe("unset");
    expect(existsSync(join(root, "state", "learn", "session.json"))).toBe(false);
  });

  it("propagates the Claude client exit status", async () => {
    const root = sandbox();
    const result = await runLearn(root, 7);
    expect(result.code).toBe(7);
  });
});
