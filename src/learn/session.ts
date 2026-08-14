import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stateDir } from "../paths";

const VERSION = 1;
const ROOT = "learn";
const LOCK = "session.json";

export interface SessionRecord {
  version: number;
  wrapperPid: number;
  childPid?: number;
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

export function learnRoot(): string {
  return join(stateDir(), ROOT);
}

export function sessionPath(): string {
  return join(learnRoot(), LOCK);
}

function owned(path: string): boolean {
  const root = resolve(learnRoot());
  const candidate = resolve(path);
  return candidate === root || candidate.startsWith(`${root}/`);
}

function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  if (live(record.wrapperPid) || (record.childPid !== undefined && live(record.childPid))) {
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
  if (current && live(current.wrapperPid)) throw new Error("A local learning session is already active.");
  if (existsSync(sessionPath()) && !recoverStaleSession()) throw new Error("Local learning session state is ambiguous. Run `aifirst learn --recover` after it exits.");

  const nonce = crypto.randomUUID();
  const profile = join(learnRoot(), `profile-${nonce}`);
  const settings = join(profile, "settings.json");
  mkdirSync(profile, { recursive: true });
  writeFileSync(settings, "{}\n", { mode: 0o600 });
  const record: SessionRecord = {
    version: VERSION,
    wrapperPid: process.pid,
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
export function claudeLaunch(session: SessionRecord, passthrough: string[], baseUrl: string): ClaudeLaunch {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_API_KEY = `synthetic-${session.nonce}`;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_LOGIN_COMMAND = "1";
  return { args: ["--bare", "--settings", session.settings, ...passthrough], env };
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
