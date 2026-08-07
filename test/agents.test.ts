import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, agentByKey, keysFromFlags, selectAgents } from "../src/agents";
import { antigravityIdeAgent } from "../src/agents/antigravity";
import { claudeAgent } from "../src/agents/claude";
import { codexAgent } from "../src/agents/codex";
import { CliError } from "../src/output";
import { commandFiles, parseSkillVersion, skillMarkdown } from "../src/skills/content";
import { VERSION } from "../src/version";

/**
 * Every test here points AIFIRST_HOME_OVERRIDE at a throwaway directory. Nothing
 * in this file may touch a real ~/.claude, ~/.codex or ~/.gemini.
 */
let home: string;
const originalHome = process.env.AIFIRST_HOME_OVERRIDE;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifirst-home-"));
  process.env.AIFIRST_HOME_OVERRIDE = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.AIFIRST_HOME_OVERRIDE;
  else process.env.AIFIRST_HOME_OVERRIDE = originalHome;
});

describe("skill markdown", () => {
  const md = skillMarkdown();

  it("carries frontmatter every agent can parse", () => {
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("\nname: aifirst\n");
    expect(md).toContain(`\nversion: ${VERSION}\n`);
  });

  it("round-trips its version", () => {
    expect(parseSkillVersion(md)).toBe(VERSION);
  });

  it("states the verbatim rule, which is the whole point of the skill", () => {
    expect(md).toContain("verbatim");
    expect(md).toContain("Do not write the code yourself");
  });

  it("teaches the json contract rather than screen-scraping", () => {
    expect(md).toContain("aifirst show <id> --format json");
    expect(md).toContain("aifirst search");
  });

  it("warns the agent off destructive commands", () => {
    expect(md).toContain("reset --all");
  });

  it("has a description narrow enough not to fire on unrelated questions", () => {
    expect(md).toContain("Skip for general Python or Java questions");
  });
});

describe("command files", () => {
  it("all have frontmatter with a description", () => {
    for (const cmd of commandFiles()) {
      expect(cmd.body.startsWith("---\n")).toBe(true);
      expect(cmd.body).toContain("description:");
    }
  });

  it("have unique names", () => {
    const names = commandFiles().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("claude adapter", () => {
  it("installs a skill and detects it as current", async () => {
    const result = await claudeAgent.install();
    expect(result.written.length).toBeGreaterThan(0);
    expect(existsSync(join(home, ".claude", "skills", "aifirst", "SKILL.md"))).toBe(true);
    expect(await claudeAgent.check()).toEqual({ state: "current", version: VERSION });
  });

  it("reports drift when the installed skill came from another version", async () => {
    await claudeAgent.install();
    const path = join(home, ".claude", "skills", "aifirst", "SKILL.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(`version: ${VERSION}`, "version: 0.0.1"));
    expect(await claudeAgent.check()).toEqual({ state: "drift", version: "0.0.1", expected: VERSION });
  });

  it("reports missing before install", async () => {
    expect(await claudeAgent.check()).toEqual({ state: "missing" });
  });

  it("removes only its own directory", async () => {
    // A sibling skill must survive uninstall.
    const sibling = join(home, ".claude", "skills", "someone-elses");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "SKILL.md"), "keep me");

    await claudeAgent.install();
    await claudeAgent.remove();

    expect(existsSync(join(home, ".claude", "skills", "aifirst"))).toBe(false);
    expect(existsSync(join(sibling, "SKILL.md"))).toBe(true);
  });

  it("is idempotent", async () => {
    await claudeAgent.install();
    await claudeAgent.install();
    expect(await claudeAgent.check()).toMatchObject({ state: "current" });
  });
});

describe("codex adapter", () => {
  it("writes the skill and slash-command prompts", async () => {
    await codexAgent.install();
    expect(existsSync(join(home, ".codex", "skills", "aifirst", "SKILL.md"))).toBe(true);
    for (const cmd of commandFiles()) {
      expect(existsSync(join(home, ".codex", "prompts", `${cmd.name}.md`))).toBe(true);
    }
  });

  it("removes only its own prompt files, not the learner's", async () => {
    const mine = join(home, ".codex", "prompts", "my-own-prompt.md");
    mkdirSync(join(home, ".codex", "prompts"), { recursive: true });
    writeFileSync(mine, "personal");

    await codexAgent.install();
    await codexAgent.remove();

    expect(existsSync(mine)).toBe(true);
    expect(existsSync(join(home, ".codex", "prompts", "aifirst-next.md"))).toBe(false);
  });

  it("never writes config.toml, which holds the learner's model and trust settings", async () => {
    const config = join(home, ".codex", "config.toml");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(config, 'model = "gpt-5.5"\n');
    await codexAgent.install();
    expect(readFileSync(config, "utf8")).toBe('model = "gpt-5.5"\n');
  });
});

describe("antigravity adapter", () => {
  it("writes a plugin bundle with plugin.json, skills and rules", async () => {
    await antigravityIdeAgent.install();
    const root = join(home, ".gemini", "config", "plugins", "aifirst");
    expect(existsSync(join(root, "plugin.json"))).toBe(true);
    expect(existsSync(join(root, "skills", "aifirst", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "rules", "aifirst.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")).name).toBe("aifirst");
  });

  it("stays inside its own plugin directory, since ~/.gemini is shared with Gemini CLI", async () => {
    const geminiSettings = join(home, ".gemini", "settings.json");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(geminiSettings, "{}");
    await antigravityIdeAgent.install();
    expect(readFileSync(geminiSettings, "utf8")).toBe("{}");
  });
});

describe("registry", () => {
  it("exposes unique keys", () => {
    const keys = AGENTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("rejects an unknown agent", () => {
    expect(() => agentByKey("emacs")).toThrow(CliError);
  });

  it("detection never throws, even with a nonexistent home", async () => {
    process.env.AIFIRST_HOME_OVERRIDE = join(home, "does", "not", "exist");
    for (const agent of AGENTS) {
      expect(await agent.detect()).toBeDefined();
    }
  });

  it("selects only detected agents by default", () => {
    const detected = [
      { agent: claudeAgent, detection: { installed: true } },
      { agent: codexAgent, detection: { installed: false } },
    ];
    expect(selectAgents([], detected).map((a) => a.key)).toEqual(["claude"]);
  });

  it("honours explicit keys even for undetected agents", () => {
    const detected = [{ agent: claudeAgent, detection: { installed: false } }];
    expect(selectAgents(["codex"], detected).map((a) => a.key)).toEqual(["codex"]);
  });

  it("reads agent selector flags", () => {
    expect(
      keysFromFlags(
        new Map<string, string | boolean>([
          ["claude", true],
          ["format", "json"],
        ]),
      ),
    ).toEqual(["claude"]);
  });
});
