/**
 * Claude Code.
 *
 * A skill directory at `~/.claude/skills/<name>/` auto-loads as
 * `<name>@skills-dir` with no registration step, so installing is purely writing
 * files — nothing in Claude's settings is touched.
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

/**
 * Read `settings.json`, tolerating absence.
 *
 * Returns undefined — distinct from `{}` — when the file exists but cannot be
 * parsed. That case must never be overwritten: it is someone's environment,
 * hooks and model configuration, and clobbering it to add a permission entry
 * would be a catastrophic trade.
 */
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
    return {
      written,
      notes: ["Loads as aifirst@skills-dir in your next Claude Code session."],
    };
  },

  async check(): Promise<SkillState> {
    const text = readIfExists(skillFile());
    if (!text) return { state: "missing" };
    const version = parseSkillVersion(text);
    return version === VERSION ? { state: "current", version } : { state: "drift", version, expected: VERSION };
  },

  async remove(): Promise<string[]> {
    return removeIfExists(paths.skill());
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
