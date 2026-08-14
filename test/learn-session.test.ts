import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeLaunch,
  cleanupSession,
  createSession,
  learningSessionStatus,
  readSession,
  recoverStaleSession,
  sessionPath,
} from "../src/learn/session";

const originalState = process.env.AIFIRST_STATE_DIR;

function useState(): string {
  const state = mkdtempSync(join(tmpdir(), "aifirst-learn-"));
  process.env.AIFIRST_STATE_DIR = state;
  return state;
}

afterEach(() => {
  if (originalState === undefined) delete process.env.AIFIRST_STATE_DIR;
  else process.env.AIFIRST_STATE_DIR = originalState;
});

describe("local Claude session", () => {
  it("uses a session-owned bare configuration without changing HOME", () => {
    const state = useState();
    const session = createSession();

    try {
      const launch = claudeLaunch(session, ["--resume", "abc"], "http://127.0.0.1:4567");
      expect(launch.args).toEqual(["--bare", "--settings", session.settings, "--resume", "abc"]);
      expect(launch.env.HOME).toBeUndefined();
      expect(launch.env.IS_DEMO).toBeUndefined();
      expect(launch.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4567");
      expect(launch.env.ANTHROPIC_API_KEY).toMatch(/^synthetic-/);
      expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(Object.values(launch.env).join("\n")).not.toContain(".claude");
      expect(launch.env.ANTHROPIC_API_KEY).not.toContain(session.profile);
      expect(existsSync(session.settings)).toBe(true);
      expect(readFileSync(session.settings, "utf8")).toBe("{}\n");
    } finally {
      cleanupSession(session);
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("records an owned versioned lock and refuses a live second session", () => {
    const state = useState();
    const session = createSession();
    try {
      expect(readSession()).toMatchObject({ version: 1, wrapperPid: process.pid, nonce: session.nonce });
      expect(() => createSession()).toThrow("already active");
    } finally {
      cleanupSession(session);
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("recovers only a dead, owned session record", () => {
    const state = useState();
    const session = createSession();
    writeFileSync(sessionPath(), JSON.stringify({ ...session, wrapperPid: 99999999 }) + "\n");
    expect(recoverStaleSession()).toBe(true);
    expect(existsSync(session.profile)).toBe(false);
    expect(existsSync(sessionPath())).toBe(false);
    rmSync(state, { recursive: true, force: true });
  });

  it("reports active, stale, and ambiguous session state without recovery", () => {
    const state = useState();
    const session = createSession();
    expect(learningSessionStatus().state).toBe("active");

    writeFileSync(sessionPath(), JSON.stringify({ ...session, wrapperPid: 99999999 }) + "\n");
    expect(learningSessionStatus().state).toBe("stale");

    writeFileSync(sessionPath(), "not JSON\n");
    expect(learningSessionStatus().state).toBe("ambiguous");
    rmSync(state, { recursive: true, force: true });
  });

  it("retains malformed state rather than deleting an ambiguous path", () => {
    const state = useState();
    const sentinel = join(state, "outside-sentinel");
    writeFileSync(sentinel, "keep\n");
    const lock = join(state, "learn", "session.json");
    mkdirSync(join(state, "learn"), { recursive: true });
    writeFileSync(lock, JSON.stringify({ version: 1, wrapperPid: 99999999, profile: sentinel }) + "\n");
    expect(recoverStaleSession()).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
    expect(existsSync(lock)).toBe(true);
    rmSync(state, { recursive: true, force: true });
  });

  it("cleans its owned state idempotently", () => {
    const state = useState();
    const session = createSession();
    cleanupSession(session);
    cleanupSession(session);
    expect(existsSync(session.profile)).toBe(false);
    expect(existsSync(sessionPath())).toBe(false);
    rmSync(state, { recursive: true, force: true });
  });

  it("does not remove a replacement session lock during old-session cleanup", () => {
    const state = useState();
    const session = createSession();
    writeFileSync(sessionPath(), JSON.stringify({ ...session, nonce: "replacement" }) + "\n");
    cleanupSession(session);
    expect(readFileSync(sessionPath(), "utf8")).toContain("replacement");
    rmSync(state, { recursive: true, force: true });
  });
});
