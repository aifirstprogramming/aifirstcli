import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERVER_TOOLS,
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
  it("uses a session-owned normal profile and TUI", () => {
    const state = useState();
    const session = createSession();

    try {
      const launch = claudeLaunch(session, ["--resume", "abc"], "http://127.0.0.1:4567");
      expect(launch.args).toEqual(["--setting-sources", "user", "--settings", session.settings, "--tools", SERVER_TOOLS, "--resume", "abc"]);
      expect(launch.env.HOME).toBe(session.profile);
      expect(launch.env.IS_DEMO).toBe("1");
      expect(launch.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4567");
      expect(launch.env.ANTHROPIC_AUTH_TOKEN).toMatch(/^synthetic-/);
      expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(Object.values(launch.env).join("\n")).not.toContain(".claude");
      expect(launch.env.HOME).toContain(session.profile);
      expect(existsSync(session.settings)).toBe(true);
      expect(JSON.parse(readFileSync(session.settings, "utf8"))).toMatchObject({
        permissions: { allow: expect.arrayContaining(["Bash(aifirst run:*)", "Bash(*)", "Edit(*)", "Read(*)", "Write(*)"]) },
      });
      expect(readFileSync(session.settings, "utf8")).not.toContain("UserPromptSubmit");
    } finally {
      cleanupSession(session);
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("does not override an explicit Claude tool selection", () => {
    const state = useState();
    const session = createSession();
    try {
      const launch = claudeLaunch(session, ["--tools", "Bash,Write"], "http://127.0.0.1:4567");
      expect(launch.args).toEqual(["--setting-sources", "user", "--settings", session.settings, "--tools", "Bash,Write"]);
    } finally {
      cleanupSession(session);
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("marks replay sessions for the installed AI First skill", () => {
    const state = useState();
    const session = createSession();
    try {
      const launch = claudeLaunch(session, [], "http://127.0.0.1:4567", "duckling");
      expect(launch.env.AIFIRST_REPLAY_NAME).toBe("duckling");
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

  it("treats a lock from another runtime as stale even when its PID is reused", () => {
    const state = useState();
    const session = createSession();
    writeFileSync(sessionPath(), JSON.stringify({ ...session, runtimeId: "different-runtime" }) + "\n");
    expect(learningSessionStatus().state).toBe("stale");
    expect(recoverStaleSession()).toBe(true);
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
    expect(readFileSync(sentinel, "utf8").trim()).toBe("keep");
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
