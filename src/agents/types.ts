/**
 * The contract every supported agent implements.
 *
 * Adapters are held to two invariants, because this CLI runs on the machines of
 * people who are new to programming and cannot debug a broken editor:
 *
 *  1. **Additive writes only.** An adapter may create files inside its own
 *     `aifirst`-named directory. It never edits an agent's settings.json, auth,
 *     model configuration, or any file it did not create. Uninstalling is
 *     therefore a directory removal that cannot leave the agent broken.
 *  2. **Detection never throws.** A missing agent is the normal case. Probing
 *     must degrade to `installed: false`, never to an error that aborts `init`.
 */

export type AgentKey = "claude" | "codex" | "antigravity" | "antigravity-cli" | "vscode";

export interface Detection {
  installed: boolean;
  /** Version string when we could get one cheaply. */
  version?: string;
  /** How it was found, shown by `doctor` (a path, or a binary name). */
  via?: string;
}

export type SkillState =
  | { state: "missing" }
  | { state: "current"; version: string }
  /** Installed, but written by a different CLI version. */
  | { state: "drift"; version?: string; expected: string };

export interface InstallResult {
  /** Paths created or overwritten, for reporting. */
  written: string[];
  /** Non-fatal notes, e.g. a fallback path taken. */
  notes?: string[];
}

export interface Agent {
  key: AgentKey;
  /** Human label used in all output. */
  label: string;
  /** What installing writes, described for the confirmation prompt. */
  target: string;
  detect(): Promise<Detection>;
  install(): Promise<InstallResult>;
  check(): Promise<SkillState>;
  remove(): Promise<string[]>;
}
