/**
 * Google Antigravity — two surfaces sharing one plugin bundle shape.
 *
 * The IDE scans `~/.gemini/config/plugins/` automatically. The CLI (`agy`) has an
 * explicit `agy plugin install <path>`, with `~/.gemini/antigravity-cli/plugins/`
 * as the underlying location we fall back to when the binary isn't on PATH.
 *
 * Note that `~/.gemini` is shared with the Gemini CLI, so every write here stays
 * strictly inside an `aifirst`-named plugin directory.
 *
 * These paths come from Antigravity's published docs rather than local
 * inspection; see the README's verification notes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { antigravity as paths } from "../paths";
import {
  antigravityPluginJson,
  antigravityRules,
  parseSkillVersion,
  skillMarkdown,
} from "../skills/content";
import { VERSION } from "../version";
import type { Agent, Detection, InstallResult, SkillState } from "./types";
import { captureVersion, readIfExists, removeIfExists, run, which, writeFileTree } from "./util";

/** Write the plugin bundle (plugin.json + skills/ + rules/) under `root`. */
function writeBundle(root: string): string[] {
  return [
    writeFileTree(join(root, "plugin.json"), antigravityPluginJson()),
    writeFileTree(join(root, "skills", "aifirst", "SKILL.md"), skillMarkdown()),
    writeFileTree(join(root, "rules", "aifirst.md"), antigravityRules()),
  ];
}

function bundleState(root: string): SkillState {
  const text = readIfExists(join(root, "skills", "aifirst", "SKILL.md"));
  if (!text) return { state: "missing" };
  const version = parseSkillVersion(text);
  return version === VERSION ? { state: "current", version } : { state: "drift", version, expected: VERSION };
}

export const antigravityIdeAgent: Agent = {
  key: "antigravity",
  label: "Antigravity (IDE)",
  target: "~/.gemini/config/plugins/aifirst/",

  async detect(): Promise<Detection> {
    if (existsSync(paths.ideRoot())) return { installed: true, via: paths.ideRoot() };
    // The IDE may be installed without ~/.gemini/config existing yet; `agy`
    // shipping alongside it is a reasonable second signal.
    const bin = which("agy");
    if (bin) return { installed: true, via: bin };
    return { installed: false };
  },

  async install(): Promise<InstallResult> {
    return {
      written: writeBundle(paths.idePlugin()),
      notes: ["Antigravity scans this directory on start; restart the IDE to pick it up."],
    };
  },

  async check(): Promise<SkillState> {
    return bundleState(paths.idePlugin());
  },

  async remove(): Promise<string[]> {
    return removeIfExists(paths.idePlugin());
  },
};

export const antigravityCliAgent: Agent = {
  key: "antigravity-cli",
  label: "Antigravity CLI (agy)",
  target: "~/.gemini/antigravity-cli/plugins/aifirst/",

  async detect(): Promise<Detection> {
    const bin = which("agy");
    if (bin) return { installed: true, version: await captureVersion(bin), via: bin };
    if (existsSync(paths.cliRoot())) return { installed: true, via: paths.cliRoot() };
    return { installed: false };
  },

  async install(): Promise<InstallResult> {
    const root = paths.cliPlugin();
    const written = writeBundle(root);
    const notes: string[] = [];

    // Prefer the documented install command so `agy` registers the plugin the way
    // it expects; the written directory is already the right shape if it fails.
    const bin = which("agy");
    if (bin) {
      const result = await run(bin, ["plugin", "install", root]);
      notes.push(
        result.ok
          ? "Registered with: agy plugin install"
          : `agy plugin install failed, left the bundle in place (agy should scan it): ${firstLine(result.output)}`,
      );
    } else {
      notes.push("agy not on PATH; wrote the plugin directory directly.");
    }

    return { written, notes };
  },

  async check(): Promise<SkillState> {
    return bundleState(paths.cliPlugin());
  },

  async remove(): Promise<string[]> {
    const bin = which("agy");
    if (bin) await run(bin, ["plugin", "uninstall", "aifirst"]);
    return removeIfExists(paths.cliPlugin());
  },
};

function firstLine(s: string): string {
  return s.split("\n")[0]?.trim() ?? "";
}
