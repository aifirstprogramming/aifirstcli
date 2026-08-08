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
import { CODEX_BEGIN, CODEX_END, codexRuleBlock } from "../permissions";
import { commandFiles, parseSkillVersion, skillMarkdown } from "../skills/content";
import { VERSION } from "../version";
import type { Agent, Detection, InstallResult, PermissionResult, PermissionState, SkillState } from "./types";
import { captureVersion, readIfExists, removeIfExists, run, which, writeFileTree } from "./util";

const skillFile = () => join(paths.skill(), "SKILL.md");
const promptFile = (name: string) => join(paths.prompts(), `${name}.md`);
const rulesFile = () => join(paths.root(), "rules", "default.rules");

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

  permissionTarget: "~/.codex/rules/default.rules",

  async grantPermissions(): Promise<PermissionResult> {
    const existing = readIfExists(rulesFile()) ?? "";
    const block = codexRuleBlock();

    if (existing.includes(block)) return { state: "allowlisted", changed: [] };

    // Replace a previous block in place rather than appending a second one.
    const next = hasBlock(existing)
      ? replaceBlock(existing, block)
      : existing.trim().length > 0
        ? `${existing.replace(/\n*$/, "")}\n\n${block}\n`
        : `${block}\n`;

    writeFileTree(rulesFile(), next);

    const notes = ["Codex reads this at startup; restart it to pick the rules up."];
    // Prove the rules parse and mean what we think, rather than assuming.
    const bin = which("codex");
    if (bin) {
      const check = await run(bin, ["execpolicy", "check", "--rules", rulesFile(), "--", "aifirst", "show", "py-1-01"]);
      notes.push(
        check.ok && /allow/i.test(check.output)
          ? "Verified with codex execpolicy check."
          : `codex execpolicy check did not report allow: ${check.output.split("\n")[0] ?? ""}`,
      );
    }

    return { state: "allowlisted", changed: [rulesFile()], notes };
  },

  async permissionState(): Promise<PermissionState> {
    const existing = readIfExists(rulesFile());
    if (existing === undefined) return "missing";
    return existing.includes(codexRuleBlock()) ? "allowlisted" : "missing";
  },

  async revokePermissions(): Promise<string[]> {
    const existing = readIfExists(rulesFile());
    if (existing === undefined || !hasBlock(existing)) return [];
    const stripped = stripBlock(existing);
    // Don't leave an empty rules file behind that we created.
    if (stripped.trim().length === 0) return removeIfExists(rulesFile());
    writeFileTree(rulesFile(), stripped);
    return [rulesFile()];
  },
};

function hasBlock(text: string): boolean {
  return text.includes(CODEX_BEGIN) && text.includes(CODEX_END);
}

function blockRange(text: string): [number, number] {
  const start = text.indexOf(CODEX_BEGIN);
  const end = text.indexOf(CODEX_END) + CODEX_END.length;
  return [start, end];
}

function replaceBlock(text: string, block: string): string {
  const [start, end] = blockRange(text);
  return `${text.slice(0, start)}${block}${text.slice(end)}`;
}

function stripBlock(text: string): string {
  const [start, end] = blockRange(text);
  return `${text.slice(0, start)}${text.slice(end)}`.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}
