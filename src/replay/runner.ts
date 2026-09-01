import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import type { Args } from "../cli";
import { learnWithClaude } from "../commands/learn";
import { startBookServer } from "../commands/serve";
import { CliError } from "../output";
import { loadReplayPack } from "./store";

function executable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = `${directory}/${name}`;
    if (existsSync(path)) return path;
  }
  return undefined;
}

export async function runReplay(name: string, mode: string, passthrough: string[]): Promise<void> {
  loadReplayPack(name);
  if (mode === "learn") {
    await learnWithClaude({
      command: "learn",
      positionals: passthrough,
      flags: new Map<string, string | boolean>([["replay", name], ["claude", true]]),
    });
    return;
  }
  if (mode !== "skill") {
    throw new CliError(`Unknown replay mode "${mode}"`, "bad_option", "Use --mode skill or --mode learn.");
  }

  const path = executable("claude");
  if (!path) throw new CliError("Claude Code is not installed or not on PATH.", "missing_claude", "Install Claude Code, then run the replay again.");
  const claude = process.platform === "win32" && !path.endsWith(".cmd") ? `${path}.cmd` : path;
  const server = startBookServer({ port: 0, quiet: true, replay: name });
  try {
    const ready = await fetch(`${server.baseUrl}/api/hello`, { signal: AbortSignal.timeout(1500) });
    if (!ready.ok) throw new Error("The replay responder did not become ready.");
    const child = spawn(claude, passthrough, {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, ANTHROPIC_BASE_URL: server.baseUrl, AIFIRST_REPLAY_NAME: name },
    });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    server.stop();
  }
}

export function replayRunArgs(args: Args): { name: string; mode: string; passthrough: string[] } {
  const name = args.positionals[1];
  if (!name) throw new CliError("Usage: aifirst replay run <name> [--mode skill|learn] [-- <claude args...>]", "bad_option");
  return {
    name,
    mode: typeof args.flags.get("mode") === "string" ? args.flags.get("mode") as string : "skill",
    passthrough: args.positionals.slice(2),
  };
}
