import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashPath, claudeAgent, claudeCliCommand } from "../src/agents/claude";
import { claudeEntries } from "../src/permissions";
import { VERSION } from "../src/version";

/**
 * The upgrade path, and the diagnostic that is supposed to police it.
 *
 * 0.2.0 shipped with `grantPermissions` wired only into `init`. `aifirst update`
 * refreshes skills through `skill install`, so everyone who upgraded got the new
 * skill and no allowlist — and kept approving every command. `doctor` then
 * reported "All good" while printing "not pre-approved" for every tool, which is
 * how it went unnoticed. These two tests are the ones that were missing.
 */

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let state: string;
const originalHome = process.env.AIFIRST_HOME_OVERRIDE;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifirst-upgrade-"));
  state = join(home, "state");
  process.env.AIFIRST_HOME_OVERRIDE = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.AIFIRST_HOME_OVERRIDE;
  else process.env.AIFIRST_HOME_OVERRIDE = originalHome;
});

async function cli(args: string[]): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
    cwd: home,
    env: {
      ...process.env,
      AIFIRST_HOME_OVERRIDE: home,
      AIFIRST_STATE_DIR: state,
      NO_COLOR: "1",
      // No agent binaries, so detection depends only on the sandbox.
      PATH: "/nonexistent",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, code: proc.exitCode ?? 0 };
}

const settingsPath = () => join(home, ".claude", "settings.json");

describe("skill install", () => {
  it("pre-approves the commands, not just init", async () => {
    // This is the fix: `update` calls this path, so it has to grant.
    await cli(["skill", "install", "--claude", "--format", "json"]);
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    for (const entry of claudeEntries(claudeCliCommand())) {
      expect(settings.permissions.allow).toContain(entry);
    }
  });

  it("honours --no-permissions and remembers the choice", async () => {
    await cli(["skill", "install", "--claude", "--no-permissions", "--format", "json"]);
    expect(await claudeAgent.permissionState()).toBe("missing");
    const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
    expect(config.permissionsOptOut).toBe(true);
  });

  it.skipIf(!Bun.which("bash"))("runs the installed launcher with a PATH that cannot resolve aifirst", async () => {
    await cli(["skill", "install", "--claude", "--format", "json"]);
    const bash = Bun.which("bash")!;
    const launcher = join(home, ".claude", "skills", "aifirst", "aifirst-cli.sh");
    const proc = Bun.spawn([bash, bashPath(launcher), "--version"], {
      cwd: home,
      env: { ...process.env, PATH: "/nonexistent", AIFIRST_HOME_OVERRIDE: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(stderr).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(stdout.trim()).toBe(VERSION);
  });
});

describe("doctor", () => {
  it("refuses to report all-good while a configured tool still prompts", async () => {
    // Reproduces exactly what an upgrade to 0.2.0 left behind.
    await cli(["skill", "install", "--claude", "--no-permissions", "--format", "json"]);
    rmSync(join(state, "config.json"), { force: true }); // forget the opt-out

    const r = await cli(["doctor", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    const claude = out.agents.find((a: { key: string }) => a.key === "claude");

    expect(claude.skill.state).toBe("current");
    expect(claude.permissions).toBe("missing");
    expect(out.ok).toBe(false);
    expect(r.code).toBe(1);
  });

  it("stays quiet when the learner opted out on purpose", async () => {
    await cli(["skill", "install", "--claude", "--no-permissions", "--format", "json"]);

    const r = await cli(["doctor", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.permissionsOptOut).toBe(true);
    expect(out.ok).toBe(true);
    expect(r.code).toBe(0);
  });

  it("is happy once the commands are pre-approved", async () => {
    await cli(["skill", "install", "--claude", "--format", "json"]);
    const r = await cli(["doctor", "--format", "json"]);
    const out = JSON.parse(r.stdout);
    expect(out.agents.find((a: { key: string }) => a.key === "claude").permissions).toBe("allowlisted");
    expect(out.ok).toBe(true);
    expect(r.code).toBe(0);
  });
});
