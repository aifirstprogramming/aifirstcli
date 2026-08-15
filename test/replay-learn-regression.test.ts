import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startBookServer } from "../src/commands/serve";

const claude = Bun.which("claude");
if (!claude) console.warn("replay-learn-regression: no `claude` binary on PATH -- skipping the live replay harness.");

describe.skipIf(!claude)("live bare-mode replay", () => {
  test("a bare Claude client receives cached replay text", async () => {
    expect(existsSync(claude as string)).toBe(true);
    const server = startBookServer({ port: 0, quiet: true, replay: "fixture" });
    try {
      const child = Bun.spawn(["claude", "--bare", "-p", "replay this"], {
        env: {
          PATH: process.env.PATH ?? "",
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
    } finally {
      server.stop();
    }
  }, 20_000);
});
