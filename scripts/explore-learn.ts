#!/usr/bin/env bun
/** Deep, non-default Linux exploration campaign for `aifirst learn`. */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { startBookServer } from "../src/commands/serve";
import {
  commandResult,
  runServerCampaign,
  runStateCampaign,
  withTimeout,
  writeExplorationReport,
  type CampaignResult,
  type ExplorationFinding,
  type ExplorationReport,
} from "./lib/learn-exploration";

const root = join(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = process.env.AIFIRST_EXPLORATION_DIR ?? join(root, "test-results", "learn-exploration", timestamp);
mkdirSync(outputDir, { recursive: true });

type ExplorationProfile = "pr" | "full" | "focused";

function profileArgument(): ExplorationProfile {
  const index = process.argv.indexOf("--profile");
  const value = index >= 0 ? process.argv[index + 1] : "full";
  if (value === "pr" || value === "full" || value === "focused") return value;
  throw new Error(`Unknown exploration profile: ${value ?? "(missing)"}`);
}

function finding(
  layer: ExplorationFinding["layer"],
  severity: ExplorationFinding["severity"],
  title: string,
  detail: string,
  artifact?: string,
): ExplorationFinding {
  return { id: randomUUID(), layer, severity, title, detail, ...(artifact ? { artifact } : {}) };
}

function sanitize(value: string): string {
  return value
    .replaceAll(/synthetic-[A-Za-z0-9-]+/g, "synthetic-[redacted]")
    .replaceAll(/ANTHROPIC_(?:AUTH_TOKEN|API_KEY)=[^\s]+/g, "ANTHROPIC_TOKEN=[redacted]")
    .replaceAll(/\/tmp\/[A-Za-z0-9._/-]+/g, "/tmp/[redacted]");
}

function artifact(name: string, contents: string): string {
  const path = join(outputDir, name);
  writeFileSync(path, sanitize(contents));
  return path;
}

function treeHash(dir: string): string {
  const hash = createHash("sha256");
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      hash.update(relative(dir, path));
      if (entry.isDirectory()) visit(path);
      else {
        hash.update(String(statSync(path).mode));
        hash.update(readFileSync(path));
      }
    }
  };
  if (existsSync(dir)) visit(dir);
  return hash.digest("hex");
}

async function preparePython(): Promise<{ path: string; bin: string; note: string; finding?: ExplorationFinding }> {
  const target = join(outputDir, "python-packages");
  const probe = await commandResult(["python3", "-c", "import pygame, PIL"], { cwd: root, timeoutMs: 10_000 });
  if (probe.exitCode === 0) return { path: process.env.PYTHONPATH ?? "", bin: "", note: "system pygame/Pillow available" };
  const install = await commandResult(
    ["python3", "-m", "pip", "install", "--quiet", "--target", target, "pygame", "Pillow"],
    { cwd: root, timeoutMs: 120_000 },
  );
  const installArtifact = artifact("python-install.log", `${install.stdout}\n${install.stderr}`);
  if (install.exitCode !== 0) {
    return {
      path: process.env.PYTHONPATH ?? "",
      bin: "",
      note: "temporary pygame/Pillow installation failed",
      finding: finding("harness", "P2", "Could not prepare temporary game dependencies", install.stderr.slice(-1000), installArtifact),
    };
  }
  const bin = join(outputDir, "python-bin");
  const python = Bun.which("python3");
  if (!python) throw new Error("python3 disappeared while preparing exploration dependencies");
  mkdirSync(bin, { recursive: true });
  for (const name of ["python", "python3"]) {
    const wrapper = join(bin, name);
    writeFileSync(wrapper, `#!/bin/sh\nPYTHONPATH='${target}' exec '${python}' "$@"\n`);
    chmodSync(wrapper, 0o755);
  }
  return {
    path: [target, process.env.PYTHONPATH].filter(Boolean).join(":"),
    bin,
    note: `temporary pygame/Pillow installed under ${target}; Python wrappers added to PATH`,
  };
}

async function runCommandCampaign(name: string, commands: string[][], env: Record<string, string>): Promise<CampaignResult> {
  const started = performance.now();
  const findings: ExplorationFinding[] = [];
  const notes: string[] = [];
  let cases = 0;
  for (const [index, command] of commands.entries()) {
    cases++;
    const result = await commandResult(command, { cwd: root, env, timeoutMs: 900_000 });
    const log = artifact(`${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${index + 1}.log`, `${result.stdout}\n${result.stderr}`);
    notes.push(`${command.join(" ")} -> ${result.exitCode} in ${result.durationMs} ms`);
    if (result.exitCode !== 0) {
      findings.push(finding("stream", "P1", `${name} command failed`, `${command.join(" ")} exited ${result.exitCode}`, log));
    }
  }
  return { name, cases, durationMs: Math.round(performance.now() - started), findings, notes };
}

interface PtyAction {
  wait: string;
  send?: string;
  down?: number;
  enter?: boolean;
  escape?: boolean;
  settleSeconds?: number;
}

interface PtyScenario {
  name: string;
  actions: PtyAction[];
  timeoutSeconds?: number;
}

const prompt = (text: string): PtyAction => ({ wait: "❯", send: text });
const picker = (down = 0): PtyAction => ({ wait: "Entertoselect", down, enter: true, settleSeconds: 0.25 });
const confirmation = (down = 0): PtyAction => ({ wait: "DidyoumeanthisAIFirstexercise?", down, enter: true, settleSeconds: 0.25 });

const PTY_SCENARIOS: PtyScenario[] = [
  { name: "ambiguity-none", actions: [prompt("duckling"), picker(2), { wait: "Nothingwaschangedorrecorded" }] },
  { name: "ambiguity-first", actions: [prompt("duckling"), picker(0), { wait: "self-containedbuildpath" }] },
  { name: "ambiguity-second", actions: [prompt("duckling"), picker(1), { wait: "Gamestyle" }] },
  { name: "ambiguity-none-retry-first", actions: [prompt("duckling"), picker(2), { wait: "Nothingwaschangedorrecorded", send: "duckling" }, picker(0), { wait: "self-containedbuildpath" }], timeoutSeconds: 35 },
  { name: "ambiguity-none-retry-second", actions: [prompt("duckling"), picker(2), { wait: "Nothingwaschangedorrecorded", send: "duckling" }, picker(1), { wait: "Gamestyle" }], timeoutSeconds: 35 },
  { name: "fuzzy-cancel", actions: [prompt("baby duckling who is trying to find its mother"), confirmation(1), { wait: "Replaycancelled" }] },
  { name: "fuzzy-cancel-retry", actions: [prompt("baby duckling who is trying to find its mother"), confirmation(1), { wait: "Replaycancelled", send: "baby duckling who is trying to find its mother" }, confirmation(0), { wait: "Gamestyle" }], timeoutSeconds: 35 },
  { name: "planning-question-escape", actions: [prompt("duckling"), picker(0), { wait: "Levelformat", escape: true }, { wait: "❯" }] },
  { name: "planning-escape-new-prompt", actions: [prompt("duckling"), picker(0), { wait: "Levelformat", escape: true }, { wait: "❯", send: "duckling" }, picker(1), { wait: "Gamestyle" }], timeoutSeconds: 35 },
  { name: "local-help", actions: [prompt("aifirst help"), { wait: "locallearningaccepts" }] },
  { name: "off-book", actions: [prompt("Explain quantum chromodynamics in limericks"), { wait: "Bookmodeison" }] },
  { name: "slash-command-boundary", actions: [prompt("/aifirst next"), { wait: "Unknowncommand" }] },
];

async function runPtyCampaign(pythonPath: string): Promise<CampaignResult> {
  const started = performance.now();
  const findings: ExplorationFinding[] = [];
  const notes: string[] = [];
  const claude = Bun.which("claude");
  if (!claude) {
    findings.push(finding("harness", "P2", "Claude Code is unavailable for PTY exploration", "No claude executable on PATH"));
    return { name: "real Claude PTY sequences", cases: 0, durationMs: 0, findings, notes };
  }
  let cases = 0;
  const filter = new Set((process.env.AIFIRST_EXPLORATION_PTY_FILTER ?? "").split(",").filter(Boolean));
  const scenarios = filter.size > 0 ? PTY_SCENARIOS.filter((scenario) => filter.has(scenario.name)) : PTY_SCENARIOS;
  for (const scenario of scenarios) {
    let failures = 0;
    let productFailures = 0;
    const logs: string[] = [];
    for (let repetition = 0; repetition < 3; repetition++) {
      cases++;
      const temp = mkdtempSync(join(tmpdir(), `aifirst-pty-${scenario.name}-`));
      const home = join(temp, "home");
      const workspace = join(temp, "workspace");
      const state = join(temp, "state");
      const settings = join(temp, "settings.json");
      const scenarioPath = join(temp, "scenario.json");
      mkdirSync(home);
      mkdirSync(workspace);
      writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(*)", "Edit(*)", "Read(*)", "Write(*)"] } }) + "\n");
      writeFileSync(join(home, ".claude.json"), JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { [workspace]: { hasTrustDialogAccepted: true, allowedTools: [] } },
      }) + "\n");
      writeFileSync(scenarioPath, JSON.stringify(scenario));
      const originalCwd = process.cwd();
      const originalState = process.env.AIFIRST_STATE_DIR;
      process.chdir(workspace);
      process.env.AIFIRST_STATE_DIR = state;
      const server = startBookServer({ port: 0, quiet: true });
      try {
        const result = await commandResult([
          "python3",
          join(root, "test", "fixtures", "learn-exploration-driver.py"),
          claude,
          settings,
          workspace,
          scenarioPath,
        ], {
          cwd: root,
          timeoutMs: ((scenario.timeoutSeconds ?? 25) + 8) * 1_000,
          env: {
            HOME: home,
            TERM: "xterm-256color",
            AIFIRST_STATE_DIR: state,
            ANTHROPIC_BASE_URL: server.baseUrl,
            ANTHROPIC_AUTH_TOKEN: `synthetic-exploration-${randomUUID()}`,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_LOGIN_COMMAND: "1",
            PYTHONPATH: pythonPath,
          },
        });
        const log = artifact(`pty-${scenario.name}-${repetition + 1}.log`, `${result.stdout}\n${result.stderr}`);
        logs.push(log);
        const visible = result.stdout
          .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, "")
          .replace(/\s+/g, "");
        const semanticSuccess = result.exitCode === 0 || (
          scenario.name === "ambiguity-none-retry-first" && visible.includes("JSONfiles")
        );
        const lastRunSelection = visible.lastIndexOf("Runthisreplay");
        const fuzzyStaleCancellation = scenario.name === "fuzzy-cancel-retry" &&
          lastRunSelection >= 0 &&
          visible.indexOf("Replaycancelled", lastRunSelection) >= 0 &&
          visible.indexOf("Gamestyle", lastRunSelection) < 0;
        const interruptedPromptRefusal = scenario.name === "planning-escape-new-prompt" &&
          visible.includes("interruptedbyuser") &&
          visible.includes("isn'taprmpt");
        if (fuzzyStaleCancellation || interruptedPromptRefusal) productFailures++;
        else if (!semanticSuccess) failures++;
      } catch (error) {
        failures++;
        logs.push(artifact(`pty-${scenario.name}-${repetition + 1}.log`, String(error)));
      } finally {
        server.stop();
        process.chdir(originalCwd);
        if (originalState === undefined) delete process.env.AIFIRST_STATE_DIR;
        else process.env.AIFIRST_STATE_DIR = originalState;
        rmSync(temp, { recursive: true, force: true });
      }
    }
    notes.push(`${scenario.name}: ${3 - failures - productFailures}/3 completed, ${productFailures}/3 product failures`);
    if (productFailures >= 2 && scenario.name === "fuzzy-cancel-retry") {
      findings.push(finding(
        "pty",
        "P1",
        "Stale fuzzy cancellation overrides a later Run selection",
        `${productFailures}/3 runs selected Run this replay but received Replay cancelled`,
        logs.at(-1),
      ));
    } else if (productFailures >= 2 && scenario.name === "planning-escape-new-prompt") {
      findings.push(finding(
        "pty",
        "P1",
        "Planning interruption metadata contaminates the next prompt",
        `${productFailures}/3 runs treated the interruption marker plus duckling as off-book prose`,
        logs.at(-1),
      ));
    }
    if (failures >= 2) {
      findings.push(finding("pty", "P2", `Real Claude PTY sequence failed repeatedly: ${scenario.name}`, `${failures}/3 failures`, logs.at(-1)));
    } else if (failures === 1) {
      findings.push(finding("harness", "P3", `Real Claude PTY sequence was flaky: ${scenario.name}`, "1/3 failures", logs.at(-1)));
    }
  }
  return { name: "real Claude PTY sequences", cases, durationMs: Math.round(performance.now() - started), findings, notes };
}

async function waitFor(path: string, milliseconds = 3_000): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(25);
  }
  return false;
}

async function runLifecycleCampaign(): Promise<CampaignResult> {
  const started = performance.now();
  const findings: ExplorationFinding[] = [];
  const notes: string[] = [];
  let cases = 0;

  const unit = await commandResult([process.execPath, "test", "test/learn.test.ts", "test/learn-session.test.ts"], { cwd: root, timeoutMs: 120_000 });
  cases += 2;
  const unitLog = artifact("lifecycle-unit.log", `${unit.stdout}\n${unit.stderr}`);
  if (unit.exitCode !== 0) findings.push(finding("lifecycle", "P1", "Lifecycle unit baseline failed", `exit ${unit.exitCode}`, unitLog));

  const temp = mkdtempSync(join(tmpdir(), "aifirst-lifecycle-"));
  const bin = join(temp, "bin");
  const state = join(temp, "state");
  const sentinel = join(temp, "sentinel-home");
  const claudeProfile = join(sentinel, ".claude");
  mkdirSync(bin);
  mkdirSync(join(claudeProfile, "skills", "user"), { recursive: true });
  writeFileSync(join(claudeProfile, "settings.json"), '{"sentinel":true}\n');
  writeFileSync(join(claudeProfile, "credentials.marker"), "do-not-touch\n");
  writeFileSync(join(claudeProfile, "skills", "user", "SKILL.md"), "user skill\n");
  const childPid = join(temp, "child.pid");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho $$ > '${childPid}'\nexec sleep 30\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const beforeHash = treeHash(claudeProfile);
  const proc = Bun.spawn([process.execPath, "run", join(root, "src", "index.ts"), "learn", "--claude"], {
    cwd: temp,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: sentinel,
      BUN_INSTALL_CACHE_DIR: join(temp, "bun-cache"),
      npm_config_cache: join(temp, "npm-cache"),
      AIFIRST_STATE_DIR: state,
      AIFIRST_HOME_OVERRIDE: sentinel,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const lock = join(state, "learn", "session.json");
  cases++;
  if (!await waitFor(lock)) {
    findings.push(finding("lifecycle", "P1", "Learn wrapper did not create its session lock", lock));
  } else {
    cases++;
    const second = await commandResult([process.execPath, "run", join(root, "src", "index.ts"), "learn", "--claude"], {
      cwd: temp,
      timeoutMs: 10_000,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: sentinel, BUN_INSTALL_CACHE_DIR: join(temp, "bun-cache"), npm_config_cache: join(temp, "npm-cache"), AIFIRST_STATE_DIR: state, AIFIRST_HOME_OVERRIDE: sentinel },
    });
    if (second.exitCode === 0 || !/already active/i.test(`${second.stdout}\n${second.stderr}`)) {
      findings.push(finding("lifecycle", "P1", "Second simultaneous learn session was not rejected", `${second.stdout}\n${second.stderr}`));
    }
  }
  proc.kill("SIGTERM");
  await withTimeout(proc.exited, 5_000, "terminated learn wrapper").catch(() => proc.kill("SIGKILL"));
  if (existsSync(childPid)) {
    try {
      process.kill(Number(readFileSync(childPid, "utf8").trim()), "SIGTERM");
    } catch {
      // The child may already have exited with the wrapper.
    }
  }

  cases++;
  if (existsSync(lock)) {
    const recovery = await commandResult([process.execPath, "run", join(root, "src", "index.ts"), "learn", "--recover"], {
      cwd: temp,
      timeoutMs: 10_000,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: sentinel, BUN_INSTALL_CACHE_DIR: join(temp, "bun-cache"), npm_config_cache: join(temp, "npm-cache"), AIFIRST_STATE_DIR: state, AIFIRST_HOME_OVERRIDE: sentinel },
    });
    if (recovery.exitCode !== 0 || existsSync(lock)) {
      findings.push(finding("lifecycle", "P1", "Stale session recovery failed after SIGTERM", `${recovery.stdout}\n${recovery.stderr}`));
    }
  }

  cases++;
  const afterHash = treeHash(claudeProfile);
  if (afterHash !== beforeHash) {
    findings.push(finding("lifecycle", "P0", "Normal profile sentinel changed during learn lifecycle tests", `${beforeHash} -> ${afterHash}`));
  }
  notes.push(`normal profile hash ${beforeHash}`);
  rmSync(temp, { recursive: true, force: true });
  return { name: "process lifecycle and profile isolation", cases, durationMs: Math.round(performance.now() - started), findings, notes };
}

async function main(): Promise<void> {
  const profile = profileArgument();
  const selected = new Set((process.env.AIFIRST_EXPLORATION_ONLY ?? "").split(",").filter(Boolean));
  if (profile === "focused" && selected.size === 0) {
    throw new Error("The focused exploration profile requires AIFIRST_EXPLORATION_ONLY.");
  }
  const defaults = profile === "pr"
    ? new Set(["state", "server"])
    : new Set(["state", "server", "live", "pty", "lifecycle"]);
  const enabled = (name: string) => (selected.size > 0 ? selected : defaults).has(name);
  const claude = Bun.which("claude");
  const claudeVersion = claude
    ? (await commandResult([claude, "--version"], { cwd: root, timeoutMs: 10_000 })).stdout.trim() || "unavailable"
    : "unavailable";
  const python = enabled("live") || enabled("pty")
    ? await preparePython()
    : { path: process.env.PYTHONPATH ?? "", bin: "", note: "game dependencies not needed for selected campaigns" };
  const env = {
    PYTHONPATH: python.path,
    PATH: [python.bin, process.env.PATH].filter(Boolean).join(":"),
    AIFIRST_LEARN_CHARS_PER_SECOND: "100000",
    AIFIRST_CLAUDE_LIVE: "1",
  };
  const campaigns: CampaignResult[] = [];
  if (python.finding) campaigns.push({ name: "temporary dependency preparation", cases: 1, durationMs: 0, findings: [python.finding], notes: [python.note] });

  const defaultStateCases = profile === "pr" ? 1_000 : 5_000;
  // runServerCampaign adds three directed cases before its randomized schedules.
  const defaultServerCases = profile === "pr" ? 97 : 200;
  if (enabled("state")) campaigns.push(await runStateCampaign(Number(process.env.AIFIRST_EXPLORATION_STATE_CASES ?? defaultStateCases)));
  if (enabled("server")) campaigns.push(await runServerCampaign(Number(process.env.AIFIRST_EXPLORATION_SERVER_CASES ?? defaultServerCases)));

  const liveFiles = [
    "test/duckling-learn-live.test.ts",
    "test/chapter10-learn-live.test.ts",
    "test/learn-confirmation-live.test.ts",
    "test/learn-interactive-regression.test.ts",
    "test/replay-learn-regression.test.ts",
  ];
  if (enabled("live")) campaigns.push(await runCommandCampaign("real Claude stream/live pass", [
    [process.execPath, "test", ...liveFiles],
    [process.execPath, "test", ...liveFiles],
  ], env));
  if (enabled("pty")) campaigns.push(await runPtyCampaign(python.path));
  if (enabled("lifecycle")) campaigns.push(await runLifecycleCampaign());

  const findings = campaigns.flatMap((campaign) => campaign.findings);
  const report: ExplorationReport = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    cliVersion: packageJson.version,
    claudeVersion,
    campaigns,
    findings,
  };
  const paths = writeExplorationReport(report, outputDir);
  console.log(JSON.stringify({
    report: paths,
    campaigns: campaigns.map((campaign) => ({ name: campaign.name, cases: campaign.cases, findings: campaign.findings.length })),
    findings: findings.length,
  }, null, 2));
  if (findings.some((item) => item.severity === "P0")) process.exitCode = 2;
  else if (findings.length > 0) process.exitCode = 1;
}

await main();
