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
  Bun.write(
    join(bin, "claude"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\nprintf '%s\\n' "$ANTHROPIC_BASE_URL" >> '${capture}'\nprintf '%s\\n' "$IS_DEMO" >> '${capture}'\nprintf '%s\\n' "\${ANTHROPIC_AUTH_TOKEN-unset}" >> '${capture}'\nprintf '%s\\n' "\${HOME-unset}" >> '${capture}'\nexit ${status}\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  const proc = Bun.spawn([process.execPath, "run", ENTRY, "learn", "--", "--resume", "reader"], {
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
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
