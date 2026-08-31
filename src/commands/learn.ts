import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import type { Args } from "../cli";
import { boolFlag, flag, stringFlag } from "../cli";
import { CliError, out } from "../output";
import { startBookServer } from "./serve";
import { claudeLaunch, cleanupSession, createSession, recoverStaleSession, updateSession } from "../learn/session";

export const DEFAULT_LEARN_CHARS_PER_SECOND = 360;

export function learnTextRate(): number | undefined {
  const configured = process.env.AIFIRST_LEARN_CHARS_PER_SECOND;
  if (configured === undefined) return DEFAULT_LEARN_CHARS_PER_SECOND;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(100_000, Math.max(30, parsed));
}

function executable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = `${directory}/${name}`;
    if (existsSync(path)) return path;
  }
  return undefined;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(value: string): string {
  return value.replace(CMD_META, "^$1");
}

function escapeCmdArgument(value: string, doubleEscapeMeta: boolean): string {
  let escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META, "^$1");
  return doubleEscapeMeta ? escaped.replace(CMD_META, "^$1") : escaped;
}

function clientCommand(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) return { command, args };
  const shellCommand = [
    escapeCmdCommand(command),
    ...args.map((argument) => escapeCmdArgument(argument, true)),
  ].join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

export async function learn(args: Args): Promise<void> {
  if (args.positionals[0] === "--recover" || boolFlag(args, "recover") || flag(args, "recover") !== undefined) {
    if (recoverStaleSession()) out("Recovered stale local learning session.");
    else out("No stale local learning session was recovered.");
    return;
  }

  const isWin = process.platform === "win32";
  const foundClaude = executable("claude");
  if (!foundClaude) throw new CliError("Claude Code is not installed or not on PATH.", "missing_claude", "Install Claude Code, then run `aifirst learn` again.");
  const claude = isWin && !foundClaude.endsWith(".cmd") ? `${foundClaude}.cmd` : foundClaude;

  const session = createSession();
  let server: ReturnType<typeof startBookServer> | undefined;
  try {
    const charsPerSecond = learnTextRate();
    server = startBookServer({
      port: 0,
      quiet: true,
      replay: stringFlag(args, "replay"),
      ...(charsPerSecond ? { textPacing: { charsPerSecond } } : {}),
    });
    const ready = await fetch(`${server.baseUrl}/api/hello`, { signal: AbortSignal.timeout(1500) });
    if (!ready.ok) throw new Error("The local learning responder did not become ready.");
    session.port = Number(new URL(server.baseUrl).port);
    updateSession(session);
    const launch = claudeLaunch(session, args.positionals, server.baseUrl, stringFlag(args, "replay"));
    const client = clientCommand(claude, launch.args);
    const child = spawn(client.command, client.args, {
      stdio: "inherit",
      shell: false,
      windowsVerbatimArguments: client.windowsVerbatimArguments,
      env: launch.env,
    });
    session.childPid = child.pid;
    updateSession(session);
    const status = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    process.exitCode = status;
  } finally {
    server?.stop();
    try {
      cleanupSession(session);
    } catch (error) {
      throw new CliError(
        `Local learning session cleanup stopped safely: ${(error as Error).message}`,
        "learn_cleanup",
        `Remove the session only after checking ${session.profile}.`,
      );
    }
  }
}
