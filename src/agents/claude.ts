/**
 * Claude Code.
 *
 * A skill directory at `~/.claude/skills/<name>/` auto-loads as
 * `<name>@skills-dir` with no registration step, so installing is purely writing
 * files — nothing in Claude's settings is touched.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { claude as paths } from "../paths";
import { commandFiles, parseSkillVersion, skillMarkdown } from "../skills/content";
import { VERSION } from "../version";
import type { Agent, Detection, InstallResult, SkillState } from "./types";
import { captureVersion, readIfExists, removeIfExists, which, writeFileTree } from "./util";

const skillFile = () => join(paths.skill(), "SKILL.md");

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
};
