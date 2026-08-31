#!/usr/bin/env bun
/** Regenerate the real-Claude rocket fixture through Showtail report v2. */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const replace = args.includes("--replace");
const outputArg = args.includes("--output")
  ? args[args.indexOf("--output") + 1]
  : undefined;
const showtailArg = args.includes("--showtail-repo")
  ? args[args.indexOf("--showtail-repo") + 1]
  : undefined;
const contentArg = args.includes("--content-repo")
  ? args[args.indexOf("--content-repo") + 1]
  : undefined;
const contentRepo = resolve(contentArg ?? join(ROOT, "..", "aifirstcontent"));
const output = resolve(
  outputArg ?? join(contentRepo, "test", "fixtures", "rocket-showtail"),
);
const showtailRepo = resolve(showtailArg ?? join(ROOT, "..", "..", "Showtail"));
const claude = Bun.which("claude");
const authHome = resolve(process.env.AIFIRST_CLAUDE_AUTH_HOME ?? homedir());
const bun = process.execPath;

export const ROCKET_PROMPT = [
  "Build a deterministic, GUI-less Python rocket launch simulation.",
  "Before planning, ask exactly one clarification question with three options about the telemetry detail; recommend the first option.",
  "Then use plan mode and wait for approval before editing files.",
  "Model two stages, fuel burn, velocity, altitude, stage separation, and a clear success/failure outcome.",
  "Print deterministic telemetry suitable for snapshot testing and add unittest coverage.",
  "The stage-separation test must use a rocket that lifts off and reaches stage 2 before any success cutoff.",
  "Use only the Python standard library, do not use web access or subagents, and keep the project small.",
  "Do not finish until python3 -m unittest -v exits successfully and two command-line simulation runs have byte-identical output.",
  "When everything passes, finish with the exact sentence: Rocket simulation complete.",
].join(" ");

function fail(message: string): never {
  throw new Error(message);
}

function run(
  command: string[],
  cwd: string,
  env: Record<string, string>,
): string {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0)
    fail(
      `${command.join(" ")} failed (${result.exitCode})\n${stderr}\n${stdout}`,
    );
  return stdout;
}

function newestTranscript(root: string, afterMs: number): string {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".jsonl")) {
        const mtimeMs = statSync(path).mtimeMs;
        if (mtimeMs >= afterMs) found.push({ path, mtimeMs });
      }
    }
  };
  visit(root);
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return found[0]?.path ?? fail(`No Claude transcript written under ${root}`);
}

function copyCredential(source: string, destination: string): void {
  if (!existsSync(source)) return;
  mkdirSync(resolve(destination, ".."), { recursive: true });
  cpSync(source, destination);
  chmodSync(destination, 0o600);
}

function copySources(sourceRoot: string, destinationRoot: string): void {
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if ([".claude", ".showtail", "__pycache__"].includes(entry.name))
        continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.name.endsWith(".py")) continue;
      const target = join(destinationRoot, relative(sourceRoot, path));
      mkdirSync(resolve(target, ".."), { recursive: true });
      cpSync(path, target);
    }
  };
  visit(sourceRoot);
}

if (!claude) fail("Claude Code is not installed");
if (!existsSync(join(showtailRepo, "src", "cli.ts")))
  fail(`Showtail checkout not found: ${showtailRepo}`);
if (existsSync(output) && readdirSync(output).length > 0) {
  if (!replace) fail(`Output directory is not empty: ${output}`);
  if (!output.endsWith(`${join("test", "fixtures", "rocket-showtail")}`))
    fail(`Refusing to replace unexpected output path: ${output}`);
  rmSync(output, { recursive: true, force: true });
}

const scratch = mkdtempSync(join(tmpdir(), "aifirst-rocket-capture-"));
const home = join(scratch, "home");
const workspace = join(scratch, "workspace");
const bin = join(scratch, "bin");
const terminalCapture = join(scratch, "claude-terminal.log");
let succeeded = false;
mkdirSync(join(home, ".claude"), { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(bin, { recursive: true });

try {
  copyCredential(join(authHome, ".claude.json"), join(home, ".claude.json"));
  copyCredential(
    join(authHome, ".claude", ".credentials.json"),
    join(home, ".claude", ".credentials.json"),
  );
  const projectConfig = existsSync(join(home, ".claude.json"))
    ? JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))
    : {};
  projectConfig.hasCompletedOnboarding = true;
  projectConfig.projects = {
    ...(projectConfig.projects ?? {}),
    [workspace]: { hasTrustDialogAccepted: true, allowedTools: [] },
  };
  writeFileSync(
    join(home, ".claude.json"),
    `${JSON.stringify(projectConfig, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(home, ".claude", ".claude.json"),
    `${JSON.stringify(projectConfig, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(home, ".claude", "settings.json"),
    `${JSON.stringify({ theme: "dark", permissions: { allow: ["Bash(*)", "Edit(*)", "Read(*)", "Write(*)"] } }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const shim = join(bin, "showtail");
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(bun)} run ${JSON.stringify(join(showtailRepo, "src", "cli.ts"))} "$@"\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    SHOWTAIL_HOME: join(scratch, "showtail-home"),
    SHOWTAIL_IDENTITY_EMAIL: "rocket-fixture@example.invalid",
    SHOWTAIL_IDENTITY_NAME: "Rocket Fixture",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TERM: "xterm-256color",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ROCKET_PROMPT,
  } as Record<string, string>;

  const showtail = [bun, "run", join(showtailRepo, "src", "cli.ts")];
  run([...showtail, "track", "--project", "Rocket Simulation"], workspace, env);
  run(
    [...showtail, "connect", "claude", "--project", "--force"],
    workspace,
    env,
  );
  const captureStarted = Date.now();
  run(
    [
      "python3",
      join(ROOT, "test", "fixtures", "rocket-capture-driver.py"),
      claude,
      workspace,
      terminalCapture,
    ],
    workspace,
    env,
  );

  const reportResult = JSON.parse(
    run(
      [...showtail, "report", "--format", "json", "--json", "--no-open"],
      workspace,
      env,
    ),
  );
  const reportPath = String(reportResult.reportPath);
  const transcriptPath = newestTranscript(
    join(home, ".claude", "projects"),
    captureStarted,
  );
  run(["python3", "-m", "unittest", "-v"], workspace, env);
  const simulationCommand = existsSync(join(workspace, "rocket_sim.py"))
    ? ["python3", "rocket_sim.py"]
    : ["python3", "-m", "rocket_sim"];
  const simulationOutput = run(simulationCommand, workspace, env);

  mkdirSync(join(output, "bundle", "source"), { recursive: true });
  mkdirSync(join(output, "oracle"), { recursive: true });
  cpSync(reportPath, join(output, "bundle", "report.json"));
  cpSync(transcriptPath, join(output, "oracle", "claude-session.jsonl"));
  cpSync(terminalCapture, join(output, "oracle", "claude-terminal.log"));
  copySources(workspace, join(output, "bundle", "source"));
  writeFileSync(
    join(output, "capture.json"),
    `${JSON.stringify(
      {
        prompt: ROCKET_PROMPT,
        claudeVersion: run([claude, "--version"], workspace, env).trim(),
        showtailVersion: run([...showtail, "--version"], workspace, env).trim(),
        selectedChoice: "first option",
        simulationCommand,
        simulationOutput,
      },
      null,
      2,
    )}\n`,
  );
  succeeded = true;
  console.log(output);
} catch (error) {
  console.error(`Capture workspace retained for debugging: ${scratch}`);
  throw error;
} finally {
  if (succeeded && !process.env.AIFIRST_KEEP_ROCKET_CAPTURE)
    rmSync(scratch, { recursive: true, force: true });
}
