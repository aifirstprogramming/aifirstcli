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

/**
 * Whether this agent will run `aifirst` without asking.
 *
 * `manual` means the agent supports an allowlist but does not document where it
 * is stored, so the CLI can only tell the learner what to add — currently
 * Antigravity.
 */
export type PermissionState = "allowlisted" | "missing" | "manual" | "unsupported";

export interface PermissionResult {
  state: PermissionState;
  /** Files actually modified, for reporting. */
  changed: string[];
  /** An instruction for the learner when the CLI cannot do it. */
  manual?: string;
  notes?: string[];
}

export interface Agent {
  key: AgentKey;
  /** Human label used in all output. */
  label: string;
  /** What installing writes, described for the confirmation prompt. */
  target: string;
  /**
   * The settings file allowlisting touches, or undefined when this agent has no
   * on-disk allowlist. Shown before asking, since it is the one file outside our
   * own directories that gets modified.
   */
  permissionTarget?: string;
  detect(): Promise<Detection>;
  install(): Promise<InstallResult>;
  check(): Promise<SkillState>;
  remove(): Promise<string[]>;
  /** Pre-approve the safe `aifirst` subcommands. */
  grantPermissions(): Promise<PermissionResult>;
  /** Report whether they are pre-approved, without changing anything. */
  permissionState(): Promise<PermissionState>;
  /** Undo exactly what grantPermissions added. */
  revokePermissions(): Promise<string[]>;
}
