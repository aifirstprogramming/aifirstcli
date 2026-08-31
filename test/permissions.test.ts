import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityIdeAgent } from "../src/agents/antigravity";
import { claudeAgent, claudeCliCommand } from "../src/agents/claude";
import { codexAgent } from "../src/agents/codex";
import { vscodeAgent } from "../src/agents/vscode";
import { ALLOWED_COMMANDS, CODEX_BEGIN, WITHHELD_COMMANDS, claudeEntries } from "../src/permissions";

/** The literal tuple type would reject arbitrary strings in these assertions. */
const allowed: readonly string[] = ALLOWED_COMMANDS;

/**
 * Allowlisting is the only thing this CLI writes outside its own directories, and
 * `~/.claude/settings.json` holds a learner's env vars, hooks and model choice.
 * These tests exist mostly to prove we never damage it.
 */

let home: string;
const originalHome = process.env.AIFIRST_HOME_OVERRIDE;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifirst-perm-"));
  process.env.AIFIRST_HOME_OVERRIDE = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.AIFIRST_HOME_OVERRIDE;
  else process.env.AIFIRST_HOME_OVERRIDE = originalHome;
});

const settingsPath = () => join(home, ".claude", "settings.json");
const rulesPath = () => join(home, ".codex", "rules", "default.rules");
const installedClaudeEntries = () => claudeEntries(claudeCliCommand());

function writeSettings(value: unknown): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(value, null, 2) + "\n");
}

describe("the allowlist itself", () => {
  it("covers the everyday loop", () => {
    for (const cmd of ["show", "next", "run", "progress", "search"]) {
      expect(allowed).toContain(cmd);
    }
  });

  it("withholds anything destructive, so it keeps prompting", () => {
    // An assistant that misreads an instruction must not be able to wipe a
    // learner's ledger or replace the binary without a human saying yes.
    for (const cmd of Object.keys(WITHHELD_COMMANDS)) {
      expect(allowed).not.toContain(cmd);
      expect(claudeEntries().join("\n")).not.toContain(`aifirst ${cmd}:`);
    }
  });

  it("scopes each entry to a single subcommand", () => {
    // `Bash(aifirst:*)` would cover reset too.
    for (const entry of claudeEntries()) {
      expect(entry).toMatch(/^Bash\(aifirst [a-z]+(?: [a-z]+)?:\*\)$/);
    }
    expect(claudeEntries()).toContain("Bash(aifirst replay execute:*)");
  });
});

describe("claude settings", () => {
  it("creates permissions when the file does not exist", async () => {
    const result = await claudeAgent.grantPermissions();
    expect(result.state).toBe("allowlisted");
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(settings.permissions.allow).toEqual(installedClaudeEntries());
  });

  it("preserves every unrelated setting", async () => {
    // The real file holds env vars, hooks and a model choice. Losing any of it to
    // add a permission entry would be a catastrophic trade.
    writeSettings({
      env: { ANTHROPIC_BASE_URL: "http://litellm:4000" },
      model: "opus[1m]",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "paplay x.oga" }] }] },
      permissions: { allow: ["Bash(ssh litellm:*)"], deny: ["Bash(rm:*)"] },
      theme: "dark",
    });

    await claudeAgent.grantPermissions();
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));

    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://litellm:4000");
    expect(settings.model).toBe("opus[1m]");
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("paplay x.oga");
    expect(settings.theme).toBe("dark");
    expect(settings.permissions.deny).toEqual(["Bash(rm:*)"]);
    // And the learner's own allow entry survives, first.
    expect(settings.permissions.allow[0]).toBe("Bash(ssh litellm:*)");
    for (const entry of installedClaudeEntries()) expect(settings.permissions.allow).toContain(entry);
  });

  it("migrates legacy bare-command permissions without disturbing unrelated entries", async () => {
    writeSettings({ permissions: { allow: ["Bash(ssh host:*)", ...claudeEntries()] } });

    await claudeAgent.grantPermissions();
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(settings.permissions.allow[0]).toBe("Bash(ssh host:*)");
    for (const entry of claudeEntries()) expect(settings.permissions.allow).not.toContain(entry);
    for (const entry of installedClaudeEntries()) expect(settings.permissions.allow).toContain(entry);
  });

  it("backs the file up before the first change", async () => {
    writeSettings({ model: "opus" });
    await claudeAgent.grantPermissions();
    const backup = join(home, ".claude", "settings.json.aifirst-backup");
    expect(existsSync(backup)).toBe(true);
    expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual({ model: "opus" });
  });

  it("is idempotent and rewrites nothing on a second run", async () => {
    await claudeAgent.grantPermissions();
    const first = readFileSync(settingsPath(), "utf8");
    const second = await claudeAgent.grantPermissions();
    expect(second.changed).toEqual([]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(first);
  });

  it("refuses to touch a file it cannot parse", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), "{ this is not json");
    const result = await claudeAgent.grantPermissions();
    expect(result.state).toBe("missing");
    expect(result.changed).toEqual([]);
    // Untouched, and it tells the learner what to add by hand.
    expect(readFileSync(settingsPath(), "utf8")).toBe("{ this is not json");
    expect(result.notes?.join(" ")).toContain("aifirst-cli.sh");
    expect(result.notes?.join(" ")).toContain(" show:*)");
  });

  it("reports state without changing anything", async () => {
    expect(await claudeAgent.permissionState()).toBe("missing");
    await claudeAgent.grantPermissions();
    expect(await claudeAgent.permissionState()).toBe("allowlisted");
  });

  it("revokes exactly its own entries", async () => {
    writeSettings({ permissions: { allow: ["Bash(ssh litellm:*)"] }, model: "opus" });
    await claudeAgent.grantPermissions();
    await claudeAgent.revokePermissions();

    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(ssh litellm:*)"]);
    expect(settings.model).toBe("opus");
  });

  it("revoking twice is harmless", async () => {
    await claudeAgent.grantPermissions();
    await claudeAgent.revokePermissions();
    expect(await claudeAgent.revokePermissions()).toEqual([]);
  });

  it("revokes legacy entries left by an older installation", async () => {
    writeSettings({ permissions: { allow: ["Bash(ssh host:*)", ...claudeEntries()] } });
    await claudeAgent.revokePermissions();
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(ssh host:*)"]);
  });
});

describe("codex rules", () => {
  it("writes a marker-delimited rule block", async () => {
    const result = await codexAgent.grantPermissions();
    expect(result.state).toBe("allowlisted");
    const rules = readFileSync(rulesPath(), "utf8");
    expect(rules).toContain(CODEX_BEGIN);
    expect(rules).toContain('pattern = ["aifirst", "show"]');
    expect(rules).toContain('decision = "allow"');
  });

  it("does not allow the withheld commands", async () => {
    await codexAgent.grantPermissions();
    const rules = readFileSync(rulesPath(), "utf8");
    for (const cmd of Object.keys(WITHHELD_COMMANDS)) {
      expect(rules).not.toContain(`"aifirst", "${cmd}"`);
    }
  });

  it("keeps rules the learner wrote themselves", async () => {
    mkdirSync(join(home, ".codex", "rules"), { recursive: true });
    const mine = 'prefix_rule(\n    pattern = ["gh"],\n    decision = "allow",\n)\n';
    writeFileSync(rulesPath(), mine);

    await codexAgent.grantPermissions();
    expect(readFileSync(rulesPath(), "utf8")).toContain('pattern = ["gh"]');

    await codexAgent.revokePermissions();
    const after = readFileSync(rulesPath(), "utf8");
    expect(after).toContain('pattern = ["gh"]');
    expect(after).not.toContain(CODEX_BEGIN);
  });

  it("is idempotent rather than appending a second block", async () => {
    await codexAgent.grantPermissions();
    await codexAgent.grantPermissions();
    const rules = readFileSync(rulesPath(), "utf8");
    expect(rules.split(CODEX_BEGIN).length - 1).toBe(1);
  });

  it("removes a rules file it created, rather than leaving an empty one", async () => {
    await codexAgent.grantPermissions();
    await codexAgent.revokePermissions();
    expect(existsSync(rulesPath())).toBe(false);
  });
});

describe("agents with no writable allowlist", () => {
  it("antigravity reports manual, with the exact entry to add", async () => {
    const result = await antigravityIdeAgent.grantPermissions();
    expect(result.state).toBe("manual");
    expect(result.changed).toEqual([]);
    expect(result.manual).toContain("command(aifirst)");
  });

  it("vscode has nothing to allowlist", async () => {
    expect((await vscodeAgent.grantPermissions()).state).toBe("unsupported");
  });
});
