import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname, platform } from "node:os";
import { stateDir } from "../paths";
import { claudeEntries } from "../permissions";

const VERSION = 1;
const ROOT = "learn";
const LOCK = "session.json";

export interface SessionRecord {
  version: number;
  wrapperPid: number;
  childPid?: number;
  runtimeId?: string;
  nonce: string;
  port?: number;
  profile: string;
  settings: string;
  createdAt: string;
}

export interface LearningSessionStatus {
  state: "none" | "active" | "stale" | "ambiguous";
  record?: SessionRecord;
}

export interface ClaudeLaunch {
  args: string[];
  env: Record<string, string>;
}

export const SERVER_TOOLS = "Bash,Edit,Read,Write,AskUserQuestion";

export function learnRoot(): string {
  return join(stateDir(), ROOT);
}

export function sessionPath(): string {
  return join(learnRoot(), LOCK);
}

function owned(path: string): boolean {
  const root = resolve(learnRoot()) + sep;
  const candidate = resolve(path);
  return candidate === resolve(learnRoot()) || candidate.startsWith(root);
}

const sep = platform() === "win32" ? "\\" : "/";

function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runtimeId(): string {
  return process.env.AIFIRST_RUNTIME_ID ?? hostname();
}

function sessionIsLive(record: SessionRecord): boolean {
  if (record.runtimeId && record.runtimeId !== runtimeId()) return false;
  return live(record.wrapperPid) || (record.childPid !== undefined && live(record.childPid));
}

export function readSession(): SessionRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(sessionPath(), "utf8")) as SessionRecord;
    if (
      record.version !== VERSION ||
      !Number.isInteger(record.wrapperPid) ||
      typeof record.nonce !== "string" ||
      typeof record.profile !== "string" ||
      typeof record.settings !== "string" ||
      !owned(record.profile) ||
      !owned(record.settings) ||
      resolve(record.settings) !== resolve(record.profile, "settings.json")
    ) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

export function learningSessionStatus(): LearningSessionStatus {
  if (!existsSync(sessionPath())) return { state: "none" };
  const record = readSession();
  if (!record) return { state: "ambiguous" };
  if (sessionIsLive(record)) {
    return { state: "active", record };
  }
  return { state: "stale", record };
}

export function recoverStaleSession(): boolean {
  const status = learningSessionStatus();
  const record = status.record;
  if (status.state !== "stale" || !record) return false;
  if (owned(record.profile)) rmSync(record.profile, { recursive: true, force: true });
  rmSync(sessionPath(), { force: true });
  return true;
}

export function createSession(): SessionRecord {
  const current = readSession();
  if (current && sessionIsLive(current)) throw new Error("A local learning session is already active.");
  if (existsSync(sessionPath()) && !recoverStaleSession()) throw new Error("Local learning session state is ambiguous. Run `aifirst learn --recover` after it exits.");

  const nonce = crypto.randomUUID();
  const profile = join(learnRoot(), `profile-${nonce}`);
  const settings = join(profile, "settings.json");
  mkdirSync(profile, { recursive: true });
  // Native learning sessions use only trusted replay operations from the
  // content pack. Approve those tools in this temporary profile without
  // changing or broadening the learner's normal Claude configuration.
  writeFileSync(settings, JSON.stringify({
    permissions: { allow: [...claudeEntries(), "Bash(*)", "Edit(*)", "Read(*)", "Write(*)"] },
  }, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(profile, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    projects: {
      [process.cwd()]: { hasTrustDialogAccepted: true, allowedTools: [] },
    },
  }, null, 2) + "\n", { mode: 0o600 });
  const record: SessionRecord = {
    version: VERSION,
    wrapperPid: process.pid,
    runtimeId: runtimeId(),
    nonce,
    profile,
    settings,
    createdAt: new Date().toISOString(),
  };
  try {
    writeFileSync(sessionPath(), JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    rmSync(profile, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("A local learning session is already active.");
    }
    throw error;
  }
  return record;
}

/** Build the child's environment without reading the learner's Claude state. */
export function claudeLaunch(session: SessionRecord, passthrough: string[], baseUrl: string, replayName?: string): ClaudeLaunch {
  const env: Record<string, string> = {};
  // Preserve terminal metadata so Claude can select its interactive TUI.
  for (const name of [
    "PATH",
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
  ]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.IS_DEMO = "1";
  // A temporary home isolates Claude's user profile without --bare/--safe-mode,
  // preserving the normal TUI and interactive built-in tools.
  env.HOME = session.profile;
  if (process.platform === "win32") env.USERPROFILE = session.profile;
  env.AIFIRST_NATIVE_REPLAY = "1";
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = `synthetic-${session.nonce}`;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_LOGIN_COMMAND = "1";
  if (replayName) env.AIFIRST_REPLAY_NAME = replayName;
  const hasToolsOption = passthrough.some((arg) => arg === "--tools" || arg.startsWith("--tools="));
  return {
    args: ["--setting-sources", "user", "--settings", session.settings, ...(hasToolsOption ? [] : ["--tools", SERVER_TOOLS]), ...passthrough],
    env,
  };
}

export function updateSession(record: SessionRecord): void {
  const current = readSession();
  if (!current || current.nonce !== record.nonce) {
    throw new Error("Local learning session ownership was lost.");
  }
  writeFileSync(sessionPath(), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}

export function cleanupSession(record: SessionRecord): void {
  if (!owned(record.profile)) throw new Error("Refusing to clean an unowned local-learning profile.");
  rmSync(record.profile, { recursive: true, force: true });
  const current = readSession();
  if (current?.nonce === record.nonce) unlinkSync(sessionPath());
}
