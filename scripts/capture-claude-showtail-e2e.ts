#!/usr/bin/env bun
/** Capture, generate, replay, and verify one real-Claude Showtail E2E fixture. */

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
import { dirname, join, relative, resolve } from "node:path";
import {
  canonicalAuthorEvents,
  canonicalLearnEvents,
  firstEventDifference,
} from "./lib/claude-e2e-oracle";
import {
  CLAUDE_E2E_SCENARIOS,
  claudeE2EScenario,
} from "./lib/claude-e2e-scenarios";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const replace = args.includes("--replace");
const scenarioIds = value("--scenario")
  ? [value("--scenario")!]
  : CLAUDE_E2E_SCENARIOS.map((scenario) => scenario.id);
const contentRepo = resolve(
  value("--content-repo") ?? join(ROOT, "..", "aifirstcontent"),
);
const showtailRepo = resolve(
  value("--showtail-repo") ?? join(ROOT, "..", "..", "Showtail"),
);
const outputRoot = resolve(
  value("--output") ??
    join(contentRepo, "test", "fixtures", "claude-showtail-e2e"),
);
const authHome = resolve(process.env.AIFIRST_CLAUDE_AUTH_HOME ?? homedir());
const claude = Bun.which("claude");
const bun = process.execPath;

function fail(message: string): never {
  throw new Error(message);
}

function run(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  allowFailure = false,
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0 && !allowFailure)
    fail(
      `${command.join(" ")} failed (${result.exitCode})\n${stderr}\n${stdout}`,
    );
  return { stdout, stderr, exitCode: result.exitCode };
}

function newestTranscript(root: string, afterMs: number): string {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
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
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
  chmodSync(destination, 0o600);
}

function filesEqual(leftRoot: string, rightRoot: string, paths: string[]): void {
  for (const path of paths) {
    const left = readFileSync(join(leftRoot, path));
    const right = readFileSync(join(rightRoot, path));
    if (!left.equals(right)) fail(`Replay source differs from author source: ${path}`);
  }
}

function captureScenario(id: string): string {
  const scenario = claudeE2EScenario(id);
  const target = join(outputRoot, scenario.id);
  if (existsSync(target) && readdirSync(target).length > 0 && !replace)
    fail(`Fixture already exists: ${target}; pass --replace`);
  if (!target.startsWith(`${outputRoot}/`)) fail(`Unsafe fixture target: ${target}`);

  const scratch = mkdtempSync(join(tmpdir(), `aifirst-${scenario.id}-capture-`));
  const home = join(scratch, "home");
  const workspace = join(scratch, "workspace");
  const replayWorkspace = join(scratch, "replay-workspace");
  const bin = join(scratch, "bin");
  const stage = join(scratch, "fixture");
  const terminalCapture = join(scratch, "author-terminal.log");
  const driverConfig = join(scratch, "author-driver.json");
  let succeeded = false;
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(replayWorkspace, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(stage, "bundle", "turns"), { recursive: true });
  mkdirSync(join(stage, "oracle"), { recursive: true });

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
    const configText = `${JSON.stringify(projectConfig, null, 2)}\n`;
    writeFileSync(join(home, ".claude.json"), configText, { mode: 0o600 });
    writeFileSync(join(home, ".claude", ".claude.json"), configText, {
      mode: 0o600,
    });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      `${JSON.stringify(
        {
          theme: "dark",
          permissions: {
            allow: ["Bash(*)", "Edit(*)", "Read(*)", "Write(*)"],
          },
        },
        null,
        2,
      )}\n`,
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
      SHOWTAIL_IDENTITY_EMAIL: `${scenario.id}@example.invalid`,
      SHOWTAIL_IDENTITY_NAME: scenario.title,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TERM: "xterm-256color",
      COLUMNS: "120",
      LINES: "40",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    } as Record<string, string>;
    const showtail = [bun, "run", join(showtailRepo, "src", "cli.ts")];
    run([...showtail, "track", "--project", scenario.title], workspace, env);
    run(
      [...showtail, "connect", "claude", "--project", "--force"],
      workspace,
      env,
    );

    const authorTurns = scenario.turns.map((turn, index) => ({
      ...turn,
      checkpoint: join(scratch, "author-turns", String(index + 1).padStart(2, "0")),
    }));
    writeFileSync(
      driverConfig,
      `${JSON.stringify({ ...scenario, turns: authorTurns }, null, 2)}\n`,
    );
    const captureStarted = Date.now();
    run(
      [
        "python3",
        join(ROOT, "test", "fixtures", "claude-e2e-author-driver.py"),
        claude!,
        workspace,
        terminalCapture,
        driverConfig,
      ],
      workspace,
      env,
    );

    const reportResult = JSON.parse(
      run(
        [...showtail, "report", "--format", "json", "--json", "--no-open"],
        workspace,
        env,
      ).stdout,
    );
    const reportPath = String(reportResult.reportPath);
    const verify = run([...showtail, "verify"], workspace, env, true);
    const knownVerifyGap =
      verify.exitCode === 3 &&
      verify.stdout.includes("FAIL  journal entries are valid") &&
      verify.stdout.includes("type: type must be one of:") &&
      verify.stdout.includes("Some checks failed");
    if (verify.exitCode !== 0 && !knownVerifyGap)
      fail(`Unexpected Showtail verification failure:\n${verify.stdout}${verify.stderr}`);
    const transcript = newestTranscript(
      join(home, ".claude", "projects"),
      captureStarted,
    );
    cpSync(reportPath, join(stage, "bundle", "report.json"));
    cpSync(transcript, join(stage, "oracle", "author-session.jsonl"));
    cpSync(terminalCapture, join(stage, "oracle", "author-terminal.log"));
    writeFileSync(
      join(stage, "oracle", "showtail-verify.log"),
      `${verify.stdout}${verify.stderr}`,
    );
    const plans = join(workspace, ".showtail", "plans");
    if (existsSync(plans))
      cpSync(plans, join(stage, "bundle", "plans"), { recursive: true });

    const capture = {
      schemaVersion: 1,
      id: scenario.id,
      exerciseId: scenario.exerciseId,
      title: scenario.title,
      claudeVersion: run([claude!, "--version"], workspace, env).stdout.trim(),
      showtailVersion: run([...showtail, "--version"], workspace, env).stdout.trim(),
      showtailVerifyExitCode: verify.exitCode,
      showtailVerifyKnownRawEventGap: knownVerifyGap,
      terminal: { term: env.TERM, columns: 120, lines: 40, locale: env.LANG },
      turns: scenario.turns.map((turn, index) => {
        const number = String(index + 1).padStart(2, "0");
        const source = `bundle/turns/${number}/source`;
        const replayCheckpoint = `oracle/learn-turns/${number}/source`;
        cpSync(authorTurns[index]!.checkpoint, join(stage, source), {
          recursive: true,
        });
        return {
          prompt: turn.prompt,
          completionMarker: turn.completionMarker,
          responsePath: turn.responsePath,
          expectedFiles: turn.expectedFiles,
          source,
          replayCheckpoint,
          ...(turn.enterPlan ? { enterPlan: true } : {}),
          ...(turn.answers ? { answers: turn.answers } : {}),
        };
      }),
      verification: scenario.verification,
    };
    writeFileSync(
      join(stage, "capture.json"),
      `${JSON.stringify(capture, null, 2)}\n`,
    );

    run(
      [
        bun,
        "run",
        join(contentRepo, "scripts", "generate-claude-e2e-test-content.ts"),
        stage,
      ],
      contentRepo,
      env,
    );
    const bookPath = join(
      stage,
      "generated",
      "books",
      `${scenario.id}.json`,
    );
    const learnEnv = {
      ...env,
      AIFIRST_CONTENT_DIR: dirname(bookPath),
      AIFIRST_STATE_DIR: join(scratch, "learn-state"),
      AIFIRST_LEARN_CHARS_PER_SECOND: "100000",
    };
    const learn = run(
      [
        "python3",
        join(ROOT, "test", "fixtures", "claude-e2e-replay-driver.py"),
        bun,
        join(ROOT, "src", "index.ts"),
        replayWorkspace,
        join(stage, "capture.json"),
        bookPath,
      ],
      replayWorkspace,
      learnEnv,
    );
    writeFileSync(join(stage, "oracle", "learn-terminal.log"), learn.stdout);

    const book = JSON.parse(readFileSync(bookPath, "utf8"));
    const report = JSON.parse(
      readFileSync(join(stage, "bundle", "report.json"), "utf8"),
    );
    const sourcePaths = [
      ...new Set(scenario.turns.flatMap((turn) => turn.expectedFiles)),
    ];
    const authorEvents = canonicalAuthorEvents(report, book, sourcePaths);
    const learnEvents = canonicalLearnEvents(learn.stdout, book, sourcePaths);
    writeFileSync(
      join(stage, "oracle", "author-events.json"),
      `${JSON.stringify(authorEvents, null, 2)}\n`,
    );
    writeFileSync(
      join(stage, "oracle", "learn-events.json"),
      `${JSON.stringify(learnEvents, null, 2)}\n`,
    );
    if (JSON.stringify(authorEvents) !== JSON.stringify(learnEvents))
      fail(firstEventDifference(authorEvents, learnEvents));

    scenario.turns.forEach((turn, index) => {
      const number = String(index + 1).padStart(2, "0");
      filesEqual(
        join(stage, "bundle", "turns", number, "source"),
        join(stage, "oracle", "learn-turns", number, "source"),
        turn.expectedFiles,
      );
    });
    const verification = scenario.verification.map((command) => ({
      command,
      ...run(command, replayWorkspace, learnEnv),
    }));
    writeFileSync(
      join(stage, "oracle", "verification.json"),
      `${JSON.stringify(verification, null, 2)}\n`,
    );

    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(stage, target, { recursive: true });
    succeeded = true;
    return target;
  } finally {
    if (succeeded && !process.env.AIFIRST_KEEP_CLAUDE_E2E_CAPTURE)
      rmSync(scratch, { recursive: true, force: true });
    else if (!succeeded)
      console.error(`Capture workspace retained for debugging: ${scratch}`);
  }
}

if (!claude) fail("Claude Code is not installed");
if (!existsSync(join(showtailRepo, "src", "cli.ts")))
  fail(`Showtail checkout not found: ${showtailRepo}`);
if (!existsSync(join(contentRepo, "scripts", "generate-claude-e2e-test-content.ts")))
  fail(`AI First content checkout not found: ${contentRepo}`);

for (const id of scenarioIds) console.log(captureScenario(id));
