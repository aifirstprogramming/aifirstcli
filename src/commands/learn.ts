import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, normalize } from "node:path";
import type { Args } from "../cli";
import { boolFlag, flag, stringFlag } from "../cli";
import { CliError, out } from "../output";
import { startBookServer } from "./serve";
import { claudeLaunch, cleanupSession, createSession, recoverStaleSession, updateSession } from "../learn/session";
import { nativeLearn } from "../learn/native";
import { learnTextRate } from "../learn/pacing";

export { DEFAULT_LEARN_CHARS_PER_SECOND, learnTextRate } from "../learn/pacing";

function executable(name: string): string | undefined {
  const suffixes = process.platform === "win32" ? [".exe", ".ps1", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const suffix of suffixes) {
      const path = `${directory}/${name}${suffix}`;
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

function escapeCmdCommand(value: string): string {
  return value.replace(CMD_META, "^$1");
}

function escapeCmdArgument(value: string, doubleEscapeMeta: boolean): string {
  let escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META, "^$1");
  return doubleEscapeMeta ? escaped.replace(CMD_META, "^$1") : escaped;
}

export function clientCommand(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32" || /\.(?:com|exe)$/i.test(command)) return { command, args };
  if (/\.ps1$/i.test(command)) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
    };
  }
  const normalized = normalize(command);
  const doubleEscapeMeta = CMD_SHIM.test(normalized);
  const shellCommand = [
    escapeCmdCommand(normalized),
    ...args.map((argument) => escapeCmdArgument(argument, doubleEscapeMeta)),
  ].join(" ");
  return {
    command: process.env.comspec ?? process.env.ComSpec ?? "cmd.exe",
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

  if (!boolFlag(args, "claude")) {
    await nativeLearn(args);
    return;
  }

  await learnWithClaude(args);
}

export async function learnWithClaude(args: Args): Promise<void> {

  const foundClaude = executable("claude");
  if (!foundClaude) throw new CliError("Claude Code is not installed or not on PATH.", "missing_claude", "Install Claude Code, then run `aifirst learn --claude` again.");
  const claude = foundClaude;

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
