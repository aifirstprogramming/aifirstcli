import { describe, expect, test } from "bun:test";
import { claudeLaunch, createSession, cleanupSession } from "../src/learn/session";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("independent local-learning contract checks", () => {
  test("launch environment contains the exact documented local-mode controls", () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-verifier-"));
    process.env.AIFIRST_STATE_DIR = root;
    const session = createSession();
    try {
      const launch = claudeLaunch(session, ["--print"], "http://127.0.0.1:43123");
      expect(launch.env.IS_DEMO).toBe("1");
      expect(launch.env.ANTHROPIC_AUTH_TOKEN).toMatch(/^synthetic-/);
      expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(launch.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:43123");
      expect(launch.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
      expect(launch.env.DISABLE_LOGIN_COMMAND).toBe("1");
    } finally {
      cleanupSession(session);
      delete process.env.AIFIRST_STATE_DIR;
    }
  });

  test("session records never expose the synthetic child credential", () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-verifier-"));
    process.env.AIFIRST_STATE_DIR = root;
    const session = createSession();
    try {
      const record = readFileSync(join(root, "learn", "session.json"), "utf8");
      expect(record).not.toContain("synthetic-");
      expect(record).not.toContain("ANTHROPIC_AUTH_TOKEN");
      expect(session.profile.startsWith(join(root, "learn"))).toBe(true);
    } finally {
      cleanupSession(session);
      delete process.env.AIFIRST_STATE_DIR;
    }
  });

  test("the native verification harness and documented release matrix exist", () => {
    expect(readFileSync("docs/learn-verification.md", "utf8")).toContain("Linux");
    expect(readFileSync("docs/learn-verification.md", "utf8")).toContain("macOS");
    expect(readFileSync("docs/learn-verification.md", "utf8")).toContain("Windows");
  });
});
