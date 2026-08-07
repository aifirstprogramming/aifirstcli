/**
 * Shared plumbing for the agent adapters.
 *
 * Everything here swallows failure by design: probing for an agent that isn't
 * installed, or whose binary errors, must not take `aifirst init` down.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Locate an executable on PATH. Returns undefined when absent. */
export function which(command: string): string | undefined {
  try {
    return Bun.which(command) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run `<command> <args>` and return trimmed stdout, or undefined on any failure.
 *
 * Short timeout: a hung editor binary must not stall detection. `code --version`
 * in particular can be slow on a cold start.
 */
export async function captureVersion(
  command: string,
  args: string[] = ["--version"],
  timeoutMs = 5000,
): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    if (proc.exitCode !== 0) return undefined;
    // Take the first line: `code --version` prints version, commit, then arch.
    const first = text.trim().split("\n")[0]?.trim();
    return first || undefined;
  } catch {
    return undefined;
  }
}

/** Run a command for effect, reporting success and captured output. */
export async function run(
  command: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);
    return { ok: proc.exitCode === 0, output: `${stdout}${stderr}`.trim() };
  } catch (e) {
    return { ok: false, output: (e as Error).message };
  }
}

/** Write a file, creating parent directories. Returns the path for reporting. */
export function writeFileTree(path: string, contents: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

export function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Remove a path if present, returning what was actually removed. */
export function removeIfExists(path: string): string[] {
  if (!existsSync(path)) return [];
  rmSync(path, { recursive: true, force: true });
  return [path];
}
