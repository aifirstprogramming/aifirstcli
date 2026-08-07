/**
 * Codex CLI.
 *
 * `~/.codex/skills/<name>/SKILL.md` for the skill, and `~/.codex/prompts/*.md`
 * for slash commands. Both are scanned from disk, so installing writes files and
 * leaves `~/.codex/config.toml` — which holds the learner's model choice and
 * project trust settings — untouched.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { codex as paths } from "../paths";
import { commandFiles, parseSkillVersion, skillMarkdown } from "../skills/content";
import { VERSION } from "../version";
import type { Agent, Detection, InstallResult, SkillState } from "./types";
import { captureVersion, readIfExists, removeIfExists, which, writeFileTree } from "./util";

const skillFile = () => join(paths.skill(), "SKILL.md");
const promptFile = (name: string) => join(paths.prompts(), `${name}.md`);

export const codexAgent: Agent = {
  key: "codex",
  label: "Codex",
  target: "~/.codex/skills/aifirst/ and ~/.codex/prompts/",

  async detect(): Promise<Detection> {
    const bin = which("codex");
    if (bin) {
      return { installed: true, version: await captureVersion(bin), via: bin };
    }
    if (existsSync(paths.root())) return { installed: true, via: paths.root() };
    return { installed: false };
  },

  async install(): Promise<InstallResult> {
    const written = [writeFileTree(skillFile(), skillMarkdown())];
    for (const cmd of commandFiles()) {
      written.push(writeFileTree(promptFile(cmd.name), cmd.body));
    }
    return { written, notes: [`Slash commands: ${commandFiles().map((c) => `/${c.name}`).join(", ")}`] };
  },

  async check(): Promise<SkillState> {
    const text = readIfExists(skillFile());
    if (!text) return { state: "missing" };
    const version = parseSkillVersion(text);
    return version === VERSION ? { state: "current", version } : { state: "drift", version, expected: VERSION };
  },

  async remove(): Promise<string[]> {
    const removed = removeIfExists(paths.skill());
    // Only our own prompt files, never the whole prompts directory — a learner
    // may well have written their own.
    for (const cmd of commandFiles()) removed.push(...removeIfExists(promptFile(cmd.name)));
    return removed;
  },
};
