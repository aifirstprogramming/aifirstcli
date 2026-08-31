import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { replayDir } from "../paths";
import { CliError } from "../output";
import type { ReplayPack } from "./types";

export function packPath(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new CliError("Replay name may contain only letters, numbers, dots, underscores, and hyphens", "bad_option");
  }
  return join(replayDir(), `${name}.json`);
}

export function loadReplayPack(name: string): ReplayPack {
  try {
    return JSON.parse(readFileSync(packPath(name), "utf8")) as ReplayPack;
  } catch {
    throw new CliError(`Replay "${name}" was not found`, "not_found");
  }
}

export function resetReplay(name: string): void {
  loadReplayPack(name);
  rmSync(join(replayDir(), `${name}.state.json`), { force: true });
}

export function replayExists(name: string): boolean {
  return existsSync(packPath(name));
}
