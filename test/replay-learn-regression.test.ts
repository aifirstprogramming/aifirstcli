import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBookServer, type BookServer } from "../src/commands/serve";

const claude = Bun.which("claude");
const liveEnabled = process.env.AIFIRST_CLAUDE_LIVE === "1";
const describeLive = liveEnabled && claude ? describe : describe.skip;

if (!liveEnabled || !claude) {
  console.warn(
    "replay-learn-regression: set AIFIRST_CLAUDE_LIVE=1 with `claude` on PATH to " +
      "verify bare-mode replay against a real client.",
  );
}

describeLive("live bare-mode replay", () => {
  let server: BookServer;
  let stateRoot: string;
  let homeRoot: string;
  const originalStateDir = process.env.AIFIRST_STATE_DIR;
  const originalHomeOverride = process.env.AIFIRST_HOME_OVERRIDE;

  beforeAll(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "aifirst-replay-state-"));
    homeRoot = mkdtempSync(join(tmpdir(), "aifirst-replay-home-"));
    const replayRoot = join(stateRoot, "replay");
    mkdirSync(replayRoot, { recursive: true });
    const fixture = {
      name: "fixture",
      sourceReportGeneratedAt: "2026-08-14T00:00:00.000Z",
      displayName: "synthetic replay fixture",
      steps: [
        {
          id: "fixture-0",
          promptText: "replay this",
          commentary: ["captured synthetic replay"],
          codeChanges: [],
          toolCalls: [],
        },
      ],
    };
    const fixturePath = join(replayRoot, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(fixture) + "\n", { mode: 0o600 });
    chmodSync(fixturePath, 0o600);
    process.env.AIFIRST_STATE_DIR = stateRoot;
    process.env.AIFIRST_HOME_OVERRIDE = homeRoot;
    server = startBookServer({ port: 0, quiet: true, replay: "fixture" });
  });

  afterAll(() => {
    server.stop();
    if (originalStateDir === undefined) delete process.env.AIFIRST_STATE_DIR;
    else process.env.AIFIRST_STATE_DIR = originalStateDir;
    if (originalHomeOverride === undefined) delete process.env.AIFIRST_HOME_OVERRIDE;
    else process.env.AIFIRST_HOME_OVERRIDE = originalHomeOverride;
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  });

  test("a bare Claude client receives cached replay text", async () => {
    expect(existsSync(claude as string)).toBe(true);
    const settings = join(homeRoot, "settings.json");
    writeFileSync(settings, "{}\n", { mode: 0o600 });
    const child = Bun.spawn(["claude", "--bare", "--settings", settings, "-p", "replay this"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: homeRoot,
        AIFIRST_STATE_DIR: stateRoot,
        AIFIRST_HOME_OVERRIDE: homeRoot,
        ANTHROPIC_BASE_URL: server.baseUrl,
        ANTHROPIC_AUTH_TOKEN: "synthetic-replay-test",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_LOGIN_COMMAND: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    await child.exited;
    expect(output).toContain("captured");
  }, 20_000);
});
