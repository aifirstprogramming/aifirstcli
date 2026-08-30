/**
 * Claude Code.
 *
 * A skill directory at `~/.claude/skills/<name>/` auto-loads as
 * `<name>@skills-dir` with no registration step. Replay adds one owned prompt
 * hook without disturbing unrelated Claude settings or hooks.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claude as paths } from "../paths";
import { claudeEntries } from "../permissions";
import { commandFiles, parseSkillVersion, skillMarkdown } from "../skills/content";
import { VERSION } from "../version";
import type { Agent, Detection, InstallResult, PermissionResult, PermissionState, SkillState } from "./types";
import { captureVersion, readIfExists, removeIfExists, which, writeFileTree } from "./util";

const skillFile = () => join(paths.skill(), "SKILL.md");
const settingsFile = () => join(paths.root(), "settings.json");
const backupFile = () => join(paths.root(), "settings.json.aifirst-backup");
const REPLAY_HOOK_COMMAND = "aifirst replay hook";

function replayHookEntry(): Record<string, unknown> {
  return { hooks: [{ type: "command", command: REPLAY_HOOK_COMMAND }] };
}

function isReplayHook(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const hooks = (value as Record<string, unknown>).hooks;
  return Array.isArray(hooks) && hooks.some((hook) =>
    Boolean(hook && typeof hook === "object" && (hook as Record<string, unknown>).command === REPLAY_HOOK_COMMAND),
  );
}

/**
 * Read `settings.json`, tolerating absence.
 *
 * Returns undefined — distinct from `{}` — when the file exists but cannot be
 * parsed. That case must never be overwritten: it is someone's environment,
 * hooks and model configuration, and clobbering it to add a permission entry
 * would be a catastrophic trade.
 */
export function claudeSettingsPath(): string {
  return settingsFile();
}

/**
 * Change one part of `settings.json`, keeping everything else.
 *
 * Exposed so book mode writes the file the same way permissions do — one backup,
 * and a refusal rather than a clobber when the file cannot be parsed. Returns false
 * when it declined to touch anything.
 */
export function updateClaudeSettings(mutate: (data: Record<string, unknown>) => void): boolean {
  const settings = readSettings();
  if (!settings) return false;
  if (settings.raw !== undefined && !existsSync(backupFile())) {
    writeFileSync(backupFile(), settings.raw);
  }
  mutate(settings.data);
  writeFileTree(settingsFile(), JSON.stringify(settings.data, null, 2) + "\n");
  return true;
}

/** Read one part of `settings.json`; undefined when it is missing or unparseable. */
export function readClaudeSettings(): Record<string, unknown> | undefined {
  return readSettings()?.data;
}

function readSettings(): { data: Record<string, unknown>; raw?: string } | undefined {
  const raw = readIfExists(settingsFile());
  if (raw === undefined) return { data: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return { data: parsed as Record<string, unknown>, raw };
  } catch {
    return undefined;
  }
}

function currentAllowList(data: Record<string, unknown>): string[] {
  const perms = data.permissions;
  if (!perms || typeof perms !== "object") return [];
  const allow = (perms as Record<string, unknown>).allow;
  return Array.isArray(allow) ? allow.filter((e): e is string => typeof e === "string") : [];
}

function installReplayHook(): boolean {
  return updateClaudeSettings((data) => {
    const hooks = (data.hooks && typeof data.hooks === "object" ? data.hooks : {}) as Record<string, unknown>;
    const prompts = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit.filter((entry) => !isReplayHook(entry)) : [];
    prompts.push(replayHookEntry());
    data.hooks = { ...hooks, UserPromptSubmit: prompts };
  });
}

function removeReplayHook(): boolean {
  return updateClaudeSettings((data) => {
    const hooks = (data.hooks && typeof data.hooks === "object" ? data.hooks : {}) as Record<string, unknown>;
    const prompts = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit.filter((entry) => !isReplayHook(entry)) : [];
    if (prompts.length > 0) data.hooks = { ...hooks, UserPromptSubmit: prompts };
    else {
      const rest = { ...hooks };
      delete rest.UserPromptSubmit;
      if (Object.keys(rest).length > 0) data.hooks = rest;
      else delete data.hooks;
    }
  });
}

export const claudeAgent: Agent = {
  key: "claude",
  label: "Claude Code",
  target: "~/.claude/skills/aifirst/",

  async detect(): Promise<Detection> {
    const bin = which("claude");
    if (bin) {
      return { installed: true, version: await captureVersion(bin), via: bin };
    }
    // Config without a binary on PATH still means Claude is in use here — the
    // launcher may not be on this shell's PATH.
    if (existsSync(paths.root())) return { installed: true, via: paths.root() };
    return { installed: false };
  },

  async install(): Promise<InstallResult> {
    const written = [writeFileTree(skillFile(), skillMarkdown())];
    for (const cmd of commandFiles()) {
      written.push(writeFileTree(join(paths.commands(), `${cmd.name}.md`), cmd.body));
    }
    if (installReplayHook()) written.push(settingsFile());
    return {
      written,
      notes: ["Loads as aifirst@skills-dir in your next Claude Code session.", "Installs the replay prompt hook."],
    };
  },

  async check(): Promise<SkillState> {
    const text = readIfExists(skillFile());
    if (!text) return { state: "missing" };
    const version = parseSkillVersion(text);
    return version === VERSION ? { state: "current", version } : { state: "drift", version, expected: VERSION };
  },

  async remove(): Promise<string[]> {
    const removed = removeIfExists(paths.skill());
    if (removeReplayHook()) removed.push(settingsFile());
    return removed;
  },

  permissionTarget: "~/.claude/settings.json",

  async grantPermissions(): Promise<PermissionResult> {
    const settings = readSettings();
    if (!settings) {
      return {
        state: "missing",
        changed: [],
        notes: [
          `${settingsFile()} could not be parsed, so it was left untouched. ` +
            `Add these to permissions.allow yourself: ${claudeEntries().join(", ")}`,
        ],
      };
    }

    const existing = currentAllowList(settings.data);
    const wanted = claudeEntries();
    const missing = wanted.filter((e) => !existing.includes(e));
    if (missing.length === 0) return { state: "allowlisted", changed: [] };

    // Keep a copy of whatever was there before the first modification, so a
    // learner (or we) can always get back to it.
    if (settings.raw !== undefined && !existsSync(backupFile())) {
      writeFileSync(backupFile(), settings.raw);
    }

    const permissions = {
      ...((settings.data.permissions as Record<string, unknown>) ?? {}),
      allow: [...existing, ...missing],
    };
    writeFileTree(settingsFile(), JSON.stringify({ ...settings.data, permissions }, null, 2) + "\n");

    return {
      state: "allowlisted",
      changed: [settingsFile()],
      notes: [`Added ${missing.length} permission entr${missing.length === 1 ? "y" : "ies"}.`],
    };
  },

  async permissionState(): Promise<PermissionState> {
    const settings = readSettings();
    if (!settings) return "missing";
    const existing = currentAllowList(settings.data);
    return claudeEntries().every((e) => existing.includes(e)) ? "allowlisted" : "missing";
  },

  async revokePermissions(): Promise<string[]> {
    const settings = readSettings();
    if (!settings) return [];
    const existing = currentAllowList(settings.data);
    const ours = new Set(claudeEntries());
    const kept = existing.filter((e) => !ours.has(e));
    if (kept.length === existing.length) return [];

    const permissions = {
      ...((settings.data.permissions as Record<string, unknown>) ?? {}),
      allow: kept,
    };
    writeFileTree(settingsFile(), JSON.stringify({ ...settings.data, permissions }, null, 2) + "\n");
    return [settingsFile()];
  },
};
