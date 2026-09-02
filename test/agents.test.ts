import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, agentByKey, keysFromFlags, selectAgents } from "../src/agents";
import { antigravityIdeAgent } from "../src/agents/antigravity";
import {
  bashPath,
  claudeAgent,
  claudeCliCommand,
  currentCliArgv,
  launcherScript,
  shellQuote,
} from "../src/agents/claude";
import { codexAgent } from "../src/agents/codex";
import { CliError } from "../src/output";
import { antigravityRules, commandFiles, parseSkillVersion, skillMarkdown } from "../src/skills/content";
import { VERSION } from "../src/version";

/** Phrases the old, defect wording used; none of the four generated surfaces may contain them. */
const FORBIDDEN_BOOK_PROVENANCE_PHRASES = [
  "The explanation is the book's too",
  "the book's explanation",
  "wording matches the book",
];

function assertNoForbiddenProvenancePhrases(text: string): void {
  for (const phrase of FORBIDDEN_BOOK_PROVENANCE_PHRASES) {
    expect(text).not.toContain(phrase);
  }
}

/** Old, defect wording reproduced as an in-memory fixture for the mutation guard below. */
const OLD_OUTPUT_FIRST_MAIN_FLOW_FIXTURE =
  "One command: it writes the book's code to a sensibly named file, executes it, and " +
  "records the exercise on success. Report the program's real output, then give the " +
  "code. Do not tell the learner an exercise is complete unless `recorded` is true or " +
  "it was already recorded.";

function orderedIndices(text: string, codeAnchor: string, outputAnchor: string): { code: number; explanation: number; output: number } {
  return {
    code: text.indexOf(codeAnchor),
    explanation: text.indexOf("Explanation"),
    output: text.indexOf(outputAnchor),
  };
}


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

  it("keeps grouped and conditional questions separate with explicit book labels", () => {
    expect(md).toContain("Follow `questionSteps` exactly");
    expect(md).toContain("Never merge a conditional follow-up");
    expect(md).toContain("Preserve option order");
    expect(md).toContain("`(Book Recommended)` suffix verbatim");
    expect(md).toContain("relative to the directory returned by `aifirst");
    expect(md).toContain("workspace <exercise-id-or-book-tag> --format json");
    expect(md).toContain("never mention or");
    expect(md).toContain("captured absolute path");
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

  it("orders code before Explanation before real output in the main-flow contract", () => {
    const { code, explanation, output } = orderedIndices(
      md,
      "One command: it writes the book's code",
      "the program's real output",
    );
    expect(code).toBeGreaterThan(-1);
    expect(explanation).toBeGreaterThan(-1);
    expect(output).toBeGreaterThan(-1);
    expect(code).toBeLessThan(explanation);
    expect(explanation).toBeLessThan(output);
  });

  it("does not claim the explanation is from the book", () => {
    assertNoForbiddenProvenancePhrases(md);
  });

  it("describes the stored explanation as AI First content-library material", () => {
    expect(md).toContain("content library");
    expect(md).toContain("Present it verbatim");
  });

  it("gives platform-specific install instructions instead of sending Windows to install.sh", () => {
    expect(md).toContain("Native Windows, including Claude Code using Git Bash");
    expect(md).toContain("install.ps1 | iex");
    expect(md).toContain("macOS, Linux, or WSL");
    expect(md).toContain("`install.sh` from Git Bash");
  });

  it("can render every executable instruction with a target-specific command", () => {
    const command = "bash '/c/Users/Ada Lovelace/.claude/skills/aifirst/aifirst-cli.sh'";
    const rendered = skillMarkdown(command);
    expect(rendered).toContain(`${command} run py-2-06 --format json`);
    expect(rendered).toContain(`${command} next --format json`);
    expect(rendered).toContain(`${command} diff <id> <file>`);
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

  it("uses a target-specific command without changing command names", () => {
    const command = "bash '/c/Users/Ada Lovelace/.claude/skills/aifirst/aifirst-cli.sh'";
    const rendered = commandFiles(command);
    expect(rendered.map((entry) => entry.name)).toEqual(commandFiles().map((entry) => entry.name));
    expect(rendered.find((entry) => entry.name === "aifirst-next")!.body).toContain(
      `${command} next --format json`,
    );
  });

  it("aifirst-next instructs code, Explanation, then output order and has no book-provenance claim", () => {
    const cmd = commandFiles().find((c) => c.name === "aifirst-next");
    expect(cmd).toBeDefined();
    const body = cmd!.body;
    const { code, explanation, output } = orderedIndices(body, "which writes the code", "the real");
    expect(code).toBeGreaterThan(-1);
    expect(explanation).toBeGreaterThan(-1);
    expect(output).toBeGreaterThan(-1);
    expect(code).toBeLessThan(explanation);
    expect(explanation).toBeLessThan(output);
    assertNoForbiddenProvenancePhrases(body);
  });

  it("aifirst-example instructs code, Explanation, then output order, uses the Explanation label, and has no book-provenance claim", () => {
    const cmd = commandFiles().find((c) => c.name === "aifirst-example");
    expect(cmd).toBeDefined();
    const body = cmd!.body;
    const { code, explanation, output } = orderedIndices(body, "Present the code **verbatim**", "program's actual output");
    expect(code).toBeGreaterThan(-1);
    expect(explanation).toBeGreaterThan(-1);
    expect(output).toBeGreaterThan(-1);
    expect(code).toBeLessThan(explanation);
    expect(explanation).toBeLessThan(output);
    expect(body).toContain("Explanation");
    assertNoForbiddenProvenancePhrases(body);
  });
});

describe("antigravityRules", () => {
  const rules = antigravityRules();

  it("drops the book-provenance claim for explanation while keeping order guidance", () => {
    assertNoForbiddenProvenancePhrases(rules);
    const codeIdx = rules.indexOf("Reproduce the");
    const explanationIdx = rules.indexOf("Explanation");
    const outputIdx = rules.indexOf("program's real");
    expect(codeIdx).toBeGreaterThan(-1);
    expect(explanationIdx).toBeGreaterThan(-1);
    expect(outputIdx).toBeGreaterThan(-1);
    expect(codeIdx).toBeLessThan(explanationIdx);
    expect(explanationIdx).toBeLessThan(outputIdx);
  });
});

describe("forbidden book-provenance phrases", () => {
  it("are absent from every generated surface: skillMarkdown, all commandFiles bodies, and antigravityRules", () => {
    assertNoForbiddenProvenancePhrases(skillMarkdown());
    for (const cmd of commandFiles()) {
      assertNoForbiddenProvenancePhrases(cmd.body);
    }
    assertNoForbiddenProvenancePhrases(antigravityRules());
  });
});

describe("mutation guard", () => {
  it("old output-first/book-provenance wording fails the new ordering assertion", () => {
    const assertOrdering = () => {
      const { code, explanation, output } = orderedIndices(
        OLD_OUTPUT_FIRST_MAIN_FLOW_FIXTURE,
        "One command: it writes the book's code",
        "the program's real output",
      );
      expect(code).toBeGreaterThan(-1);
      expect(explanation).toBeGreaterThan(-1);
      expect(output).toBeGreaterThan(-1);
      expect(code).toBeLessThan(explanation);
      expect(explanation).toBeLessThan(output);
    };
    // Applying the exact assertion the fixed skillMarkdown() test uses, against the
    // old wording, must throw: proves the guard is not vacuously true.
    expect(assertOrdering).toThrow();
  });
});

describe("claude launcher", () => {
  it("converts native Windows paths for Git Bash", () => {
    expect(bashPath("C:\\Users\\Ada Lovelace\\.claude\\skills", "win32")).toBe(
      "/c/Users/Ada Lovelace/.claude/skills",
    );
    expect(bashPath("/home/ada/.claude/skills", "linux")).toBe("/home/ada/.claude/skills");
  });

  it("quotes spaces and apostrophes without permitting shell expansion", () => {
    expect(shellQuote("/home/O'Brien/aifirst")).toBe("'/home/O'\\''Brien/aifirst'");
  });

  it("preserves the source entrypoint but needs only the executable when compiled", () => {
    const entry = join(import.meta.dir, "..", "src", "index.ts");
    expect(currentCliArgv("/opt/bun", ["/opt/bun", entry, "init"])).toEqual(["/opt/bun", entry]);
    expect(currentCliArgv("C:\\Program Files\\Bun\\bun.exe", ["bun.exe", entry, "init"])).toEqual([
      "C:\\Program Files\\Bun\\bun.exe",
      entry,
    ]);
    expect(currentCliArgv("C:\\Tools\\aifirst.exe", ["C:\\Tools\\aifirst.exe", "init"])).toEqual([
      "C:\\Tools\\aifirst.exe",
    ]);
    expect(currentCliArgv("/opt/aifirst-linux-x64", ["/opt/aifirst-linux-x64", entry, "init"])).toEqual([
      "/opt/aifirst-linux-x64",
    ]);
  });

  it("writes a forwarding script using absolute Git Bash paths", () => {
    const script = launcherScript(["C:\\Program Files\\Bun\\bun.exe", "C:\\work\\src\\index.ts"], "win32");
    expect(script).toContain("exec '/c/Program Files/Bun/bun.exe' '/c/work/src/index.ts' \"$@\"");
    expect(script).not.toContain("C:\\");
  });
});

describe("claude adapter", () => {
  it("installs a skill and detects it as current", async () => {
    const result = await claudeAgent.install();
    expect(result.written.length).toBeGreaterThan(0);
    const root = join(home, ".claude", "skills", "aifirst");
    expect(existsSync(join(root, "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "aifirst-cli.sh"))).toBe(true);
    expect(readFileSync(join(root, "SKILL.md"), "utf8")).toContain(claudeCliCommand());
    expect(readFileSync(join(root, "commands", "aifirst-next.md"), "utf8")).toContain(claudeCliCommand());
    expect(await claudeAgent.check()).toEqual({ state: "current", version: VERSION });
  });

  it("installs a marker-owned PATH-independent hook", async () => {
    await claudeAgent.install();
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(command).toStartWith(`${claudeCliCommand()} replay hook`);
    expect(command).toEndWith("# aifirst-managed-replay-hook-v1");
    expect(command).not.toBe("aifirst replay hook");
  });

  it("migrates the legacy bare replay hook", async () => {
    const settingsPath = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "aifirst replay hook" }] }] },
    }));

    await claudeAgent.install();
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toStartWith(claudeCliCommand());
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
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("preserves unrelated hooks on install and removal", async () => {
    const settingsPath = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ model: "sonnet", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine" }] }], Stop: [{ hooks: [{ type: "command", command: "stop" }] }] } }));
    await claudeAgent.install();
    await claudeAgent.remove();
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ model: "sonnet", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine" }] }], Stop: [{ hooks: [{ type: "command", command: "stop" }] }] } });
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
