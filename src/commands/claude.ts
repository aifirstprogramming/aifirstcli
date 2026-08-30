/** Launch Claude Code against the local AI First Messages API server. */

import { spawn } from "node:child_process";
import { startBookServer } from "./serve";
import type { Args } from "../cli";
import { CliError } from "../output";
import { SERVER_TOOLS } from "../learn/session";

function claudePath(): string | undefined {
  return Bun.which("claude") ?? undefined;
}

export async function claude(args: Args): Promise<void> {
  const path = claudePath();
  if (!path) {
    throw new CliError("Claude Code is not installed or not on PATH.", "missing_claude", "Install Claude Code, then run `aifirst claude` again.");
  }

  const server = startBookServer({ port: 0, quiet: true });
  try {
    const ready = await fetch(`${server.baseUrl}/api/hello`, { signal: AbortSignal.timeout(1500) });
    if (!ready.ok) throw new Error("The AI First Claude server did not become ready.");
    const hasToolsOption = args.positionals.some((arg) => arg === "--tools" || arg.startsWith("--tools="));
    const claudeArgs = [...(hasToolsOption ? [] : ["--tools", SERVER_TOOLS]), ...args.positionals];
    const child = spawn(path, claudeArgs, {
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: server.baseUrl,
        AIFIRST_NATIVE_REPLAY: "1",
        ...(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY ? {} : { ANTHROPIC_AUTH_TOKEN: "synthetic-aifirst" }),
      },
    });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    server.stop();
  }
}
