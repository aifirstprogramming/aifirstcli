import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import type { Args } from "../cli";
import { boolFlag, flag, stringFlag } from "../cli";
import { CliError, out } from "../output";
import { startBookServer } from "./serve";
import { claudeLaunch, cleanupSession, createSession, recoverStaleSession, updateSession } from "../learn/session";

function executable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = `${directory}/${name}`;
    if (existsSync(path)) return path;
  }
  return undefined;
}

export async function learn(args: Args): Promise<void> {
  if (args.positionals[0] === "--recover" || boolFlag(args, "recover") || flag(args, "recover") !== undefined) {
    if (recoverStaleSession()) out("Recovered stale local learning session.");
    else out("No stale local learning session was recovered.");
    return;
  }

  const isWin = process.platform === "win32";
  const resolvedClaude = executable("claude");
  if (!resolvedClaude) {
    throw new CliError("Claude Code is not installed or not on PATH.", "missing_claude", "Install Claude Code, then run `aifirst learn` again.");
  }
  const claude = isWin && !resolvedClaude.endsWith(".cmd") ? `${resolvedClaude}.cmd` : resolvedClaude;

  const session = createSession();
  let server: ReturnType<typeof startBookServer> | undefined;
  try {
    server = startBookServer({ port: 0, quiet: true, replay: stringFlag(args, "replay") });
    const ready = await fetch(`${server.baseUrl}/api/hello`, { signal: AbortSignal.timeout(1500) });
    if (!ready.ok) throw new Error("The local learning responder did not become ready.");
    session.port = Number(new URL(server.baseUrl).port);
    updateSession(session);
    const launch = claudeLaunch(session, args.positionals, server.baseUrl);
    const child = spawn(claude, launch.args, {
      stdio: "inherit",
      shell: false,
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
