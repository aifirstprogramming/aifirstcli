/**
 * Every filesystem location the CLI touches, in one place.
 *
 * Two rules hold throughout:
 *  - Learner state lives under one directory the student can inspect and delete.
 *  - Agent config is only ever written to inside an `aifirst`-named subdirectory,
 *    never into a shared settings file, so uninstalling is a directory removal
 *    and we can never corrupt someone's editor or auth setup.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

export const isWindows = platform() === "win32";

/** Home directory, with an env override so tests never touch a real home. */
export function home(): string {
  return process.env.AIFIRST_HOME_OVERRIDE ?? homedir();
}

/**
 * Root for learner state: progress log and downloaded content packs.
 *
 * `%LOCALAPPDATA%\aifirst` on Windows, `$XDG_STATE_HOME/aifirst` when set, and
 * `~/.aifirst` otherwise — the last being what the book prints.
 */
export function stateDir(): string {
  if (process.env.AIFIRST_STATE_DIR) return process.env.AIFIRST_STATE_DIR;
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? join(home(), "AppData", "Local");
    return join(localAppData, "aifirst");
  }
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "aifirst");
  return join(home(), ".aifirst");
}

export function progressFile(): string {
  return join(stateDir(), "progress.json");
}

/** Root for downloaded content packs, which take precedence over the embedded one. */
export function contentDir(): string {
  return join(stateDir(), "content");
}

/** Stored Showtail replay packs and their playback bookmarks. */
export function replayDir(): string {
  return join(stateDir(), "replay");
}

// ---------------------------------------------------------------------------
// Agent locations
// ---------------------------------------------------------------------------

/** Claude Code: skills here auto-load as `<name>@skills-dir`. */
export const claude = {
  root: () => join(home(), ".claude"),
  skill: () => join(home(), ".claude", "skills", "aifirst"),
  commands: () => join(home(), ".claude", "skills", "aifirst", "commands"),
};

/** Codex: `skills/` for the skill, `prompts/` for slash commands. */
export const codex = {
  root: () => join(home(), ".codex"),
  skill: () => join(home(), ".codex", "skills", "aifirst"),
  prompts: () => join(home(), ".codex", "prompts"),
};

/**
 * Antigravity shares `~/.gemini` with the Gemini CLI, so both of these live
 * beside Gemini's own config. We only ever create `aifirst`-named directories
 * under them.
 */
export const antigravity = {
  /** IDE: scanned automatically. */
  idePlugin: () => join(home(), ".gemini", "config", "plugins", "aifirst"),
  /** CLI (`agy`). */
  cliPlugin: () => join(home(), ".gemini", "antigravity-cli", "plugins", "aifirst"),
  ideRoot: () => join(home(), ".gemini", "config"),
  cliRoot: () => join(home(), ".gemini", "antigravity-cli"),
};
