import { describe, expect, test } from "bun:test";
import {
  claudeLaunch,
  createSession,
  cleanupSession,
} from "../src/learn/session";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("independent local-learning contract checks", () => {
  test("launch environment contains the exact documented local-mode controls", () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-verifier-"));
    process.env.AIFIRST_STATE_DIR = root;
    const session = createSession();
    try {
      const launch = claudeLaunch(
        session,
        ["--print"],
        "http://127.0.0.1:43123",
      );
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
    const verification = readFileSync("docs/learn-verification.md", "utf8");
    expect(verification).toContain("Linux");
    expect(verification).toContain("macOS");
    expect(verification).toContain("Windows");
    expect(verification).toContain("bun run explore:learn:pr");
    expect(verification).toContain("bun run explore:learn:full");
  });

  test("Claude compatibility automation has an exact pin and release gate", () => {
    const pin = readFileSync(".github/claude-code-version", "utf8").trim();
    const nightly = readFileSync(".github/workflows/learn-compatibility.yml", "utf8");
    const drift = readFileSync(".github/workflows/claude-version-drift.yml", "utf8");
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(nightly).toContain("@anthropic-ai/claude-code@$VERSION");
    expect(nightly).toContain("bun run explore:learn:full");
    expect(drift).toContain("npm view @anthropic-ai/claude-code version");
    expect(drift).toContain("git push origin HEAD:main");
    expect(drift).toContain("claude-compat");
    expect(release).toContain("uses: ./.github/workflows/learn-compatibility.yml");
  });

  test("X11 is confined to the non-root manual launcher", () => {
    const manual = readFileSync("scripts/docker-test.sh", "utf8");
    const live = readFileSync("scripts/docker-live-test.sh", "utf8");
    expect(manual).toContain("/tmp/.X11-unix");
    expect(manual).toContain("--cap-drop ALL");
    expect(manual).toContain("--security-opt no-new-privileges");
    expect(manual).toContain("docker-no-xshm.json");
    expect(live).not.toContain("docker-no-xshm.json");
    expect(live).toContain("rocket-showtail-e2e.test.ts");
    expect(live).toContain("AIFIRST_CONTENT_REPO");
    expect(live).not.toContain("XAUTHORITY");
  });
});
