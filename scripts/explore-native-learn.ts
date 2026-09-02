#!/usr/bin/env bun
/** Operational exploration for the built-in terminal learner and Docker image. */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";
import {
  commandResult,
  writeExplorationReport,
  type CampaignResult,
  type ExplorationFinding,
  type ExplorationReport,
} from "./lib/learn-exploration";

const root = join(import.meta.dir, "..");
const entry = join(root, "src", "index.ts");
const driver = join(root, "test", "fixtures", "native-learn-driver.py");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = process.env.AIFIRST_EXPLORATION_DIR ?? join(root, "test-results", "learn-exploration", timestamp);
const content = resolveContent().content;
mkdirSync(outputDir, { recursive: true });

interface Scenario {
  name: string;
  initialBook?: "py" | "java" | "all";
  completeBook?: "py" | "java";
  answers: string[];
  expect?: string[];
  reject?: string[];
  expectedBook?: "py" | "java" | "all";
  expectedFile?: string;
  expectedProgress?: string;
  expectNoExercises?: boolean;
  seedFile?: { path: string; content: string };
  preserveSeedFile?: boolean;
  corruptConfig?: boolean;
  corruptProgress?: boolean;
  expectedExit?: number;
  availableCommands?: string[];
  after?: { marker: string; expect?: string[]; reject?: string[] };
}

const scenarios: Scenario[] = [
  {
    name: "fresh-python-onboarding",
    answers: ["py", "6"],
    expect: ["AIFirstPythonProgramming", "Continuewithpy-1-01"],
    expectedBook: "py",
  },
  {
    name: "book-tag-switches-from-java",
    initialBook: "java",
    answers: ["py", "6"],
    expect: ["AIFirstPythonProgramming"],
    reject: ["Choosetheexercisematchingpy"],
    expectedBook: "py",
  },
  {
    name: "full-id-crosses-books",
    initialBook: "java",
    answers: ["py-2-01", "run", "exit"],
    expect: ["Lessoncomplete", "py-2-01"],
    expectedBook: "py",
    expectedFile: "basket_of_fruits.py",
    expectedProgress: "py-2-01",
  },
  {
    name: "decimal-does-not-select-search-result",
    initialBook: "py",
    answers: ["Basket of Fruits", "2.1", "1", "run", "exit"],
    expect: ["Enter1-2", "Lessoncomplete"],
    expectedFile: "basket_of_fruits.py",
  },
  {
    name: "short-search-is-rejected",
    initialBook: "py",
    answers: ["ai", "6"],
    expect: ["Noexercisematchesai"],
    expectNoExercises: true,
  },
  {
    name: "empty-chapter-returns-to-menu",
    initialBook: "py",
    answers: ["4", "8", "back", "6"],
    expect: ["Noexercisesarepublishedforthischapteryet", "Viewprogress"],
    expectNoExercises: true,
  },
  {
    name: "read-only-navigation",
    initialBook: "py",
    answers: ["3", "2", "py-2-01", "6"],
    expect: ["py-2-01", "apples=5"],
    reject: ["Lessoncomplete"],
    expectedProgress: undefined,
    expectNoExercises: true,
  },
  {
    name: "learner-file-is-never-forced-over",
    initialBook: "py",
    answers: ["2.1", "2", "6"],
    expect: ["alreadyexistswithdifferentcontents", "Lessonpaused"],
    seedFile: { path: "basket_of_fruits.py", content: "print('my own work')\n" },
    preserveSeedFile: true,
    expectNoExercises: true,
  },
  {
    name: "corrupt-state-recovers-to-onboarding",
    answers: ["py", "6"],
    expect: ["Whichbookareyoureading", "AIFirstPythonProgramming"],
    expectedBook: "py",
    corruptConfig: true,
    corruptProgress: true,
  },
  {
    name: "ctrl-c-exits-cleanly-from-main-menu",
    initialBook: "py",
    answers: ["__CTRL_C__"],
    reject: ["Error:", "timedout", "unexpectedanswer"],
  },
  {
    name: "completed-book-stays-navigable",
    initialBook: "py",
    completeBook: "py",
    answers: ["5"],
    expect: ["Everyavailableexerciseishandled", "Browsechaptersandrunanexercise", "Viewprogress"],
  },
  {
    name: "all-books-shorthand-is-explicit",
    initialBook: "all",
    answers: ["2.1", "2", "run", "exit"],
    expect: ["Choosetheexercisematching2.1", "py-2-01", "Lessoncomplete"],
    expectedBook: "py",
  },
  {
    name: "sanitized-workspace-command-is-materialized",
    initialBook: "java",
    answers: ["java-11-01", "1", "3", "exit"],
    availableCommands: ["mvn"],
    expect: ["Thisdirectorymatchesyourbook'spattern", "Planningendedwithoutchangingfiles"],
    reject: ["didnotmatchthecapturedresult", "Replaystopped"],
    expectNoExercises: true,
  },
];

function compact(value: string): string {
  return value.replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, "").replace(/\s+/g, "");
}

function artifact(name: string, text: string): string {
  const path = join(outputDir, name);
  writeFileSync(path, text.replaceAll(/\/tmp\/[A-Za-z0-9._/-]+/g, "/tmp/[redacted]"));
  return path;
}

function finding(title: string, detail: string, path: string, severity: ExplorationFinding["severity"] = "P1"): ExplorationFinding {
  return { id: randomUUID(), layer: "pty", severity, title, detail, artifact: path };
}

function book(tag: "py" | "java") {
  return content.books.find((candidate) => candidate.tag === tag)!;
}

function filesBelow(path: string): string[] {
  if (!existsSync(path)) return [];
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else files.push(child);
    }
  };
  visit(path);
  return files;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function runSourceCampaign(): Promise<CampaignResult> {
  const started = performance.now();
  const findings: ExplorationFinding[] = [];
  const notes: string[] = [];

  for (const scenario of scenarios) {
    const sandbox = mkdtempSync(join(tmpdir(), `aifirst-native-explore-${scenario.name}-`));
    const state = join(sandbox, "state");
    const home = join(sandbox, "home");
    const workspace = join(sandbox, "workspace");
    mkdirSync(state);
    mkdirSync(home);
    mkdirSync(workspace);

    const commandBin = join(sandbox, "bin");
    if (scenario.availableCommands?.length) {
      mkdirSync(commandBin);
      for (const command of scenario.availableCommands) {
        const shim = join(commandBin, command);
        writeFileSync(shim, "#!/bin/sh\nexit 0\n");
        chmodSync(shim, 0o755);
      }
    }

    if (scenario.corruptConfig) writeFileSync(join(state, "config.json"), "{not json");
    if (scenario.corruptProgress) writeFileSync(join(state, "progress.json"), "[wrong shape]");

    if (scenario.initialBook) {
      const selected = scenario.initialBook === "all" ? "all" : book(scenario.initialBook).id;
      const key = scenario.initialBook;
      writeFileSync(join(state, "config.json"), JSON.stringify({
        version: 1,
        book: selected,
        workspaces: { [key]: workspace },
      }));
    }
    if (scenario.completeBook) {
      const selected = book(scenario.completeBook);
      writeFileSync(join(state, "progress.json"), JSON.stringify({
        version: 1,
        exercises: Object.fromEntries(content.examples
          .filter((example) => example.bookId === selected.id)
          .map((example) => [example.id, { status: "done", at: "2026-01-01T00:00:00.000Z", via: "self" }])),
      }));
    }
    if (scenario.seedFile) writeFileSync(join(workspace, scenario.seedFile.path), scenario.seedFile.content);

    const result = await commandResult([
      "python3",
      driver,
      process.execPath,
      "run",
      entry,
      "learn",
      "--plain",
      "--no-animation",
    ], {
      cwd: sandbox,
      timeoutMs: 45_000,
      env: {
        AIFIRST_STATE_DIR: state,
        AIFIRST_HOME_OVERRIDE: home,
        AIFIRST_LEARN_CHARS_PER_SECOND: "0",
        AIFIRST_LEARN_TEST_ANSWERS: JSON.stringify(scenario.answers),
        PATH: scenario.availableCommands?.length
          ? `${commandBin}:${process.env.PATH ?? ""}`
          : process.env.PATH ?? "",
        NO_COLOR: "1",
      },
    });
    const log = artifact(`native-${scenario.name}.log`, `${result.stdout}\n${result.stderr}`);
    const visible = compact(`${result.stdout}\n${result.stderr}`);
    const problems: string[] = [];
    const expectedExit = scenario.expectedExit ?? 0;
    if (result.exitCode !== expectedExit) problems.push(`exit ${result.exitCode} != ${expectedExit}`);
    for (const expected of scenario.expect ?? []) if (!visible.includes(expected)) problems.push(`missing ${expected}`);
    for (const rejected of scenario.reject ?? []) if (visible.includes(rejected)) problems.push(`unexpected ${rejected}`);
    if (scenario.after) {
      const marker = visible.indexOf(scenario.after.marker);
      if (marker < 0) problems.push(`missing marker ${scenario.after.marker}`);
      else {
        const remainder = visible.slice(marker);
        for (const expected of scenario.after.expect ?? []) if (!remainder.includes(expected)) problems.push(`missing after marker ${expected}`);
        for (const rejected of scenario.after.reject ?? []) if (remainder.includes(rejected)) problems.push(`unexpected after marker ${rejected}`);
      }
    }

    const configPath = join(state, "config.json");
    const config = existsSync(configPath) ? readJson(configPath, {} as { book?: string }) : {};
    if (scenario.expectedBook) {
      const expected = scenario.expectedBook === "all" ? "all" : book(scenario.expectedBook).id;
      if (config.book !== expected) problems.push(`book ${String(config.book)} != ${expected}`);
    }
    const files = filesBelow(home).concat(filesBelow(workspace));
    if (scenario.expectedFile && !files.some((file) => file.endsWith(scenario.expectedFile!))) {
      problems.push(`missing file ${scenario.expectedFile}`);
    }
    if (scenario.seedFile && scenario.preserveSeedFile) {
      const seeded = join(workspace, scenario.seedFile.path);
      if (!existsSync(seeded) || readFileSync(seeded, "utf8") !== scenario.seedFile.content) {
        problems.push(`learner file changed: ${scenario.seedFile.path}`);
      }
    }
    const progressPath = join(state, "progress.json");
    const progress = existsSync(progressPath)
      ? readJson(progressPath, { exercises: {} } as { exercises?: Record<string, unknown> })
      : { exercises: {} };
    if (scenario.expectedProgress && !progress.exercises?.[scenario.expectedProgress]) {
      problems.push(`missing progress ${scenario.expectedProgress}`);
    }
    if (scenario.expectNoExercises && Object.keys(progress.exercises ?? {}).length > 0) {
      problems.push("read-only/menu scenario recorded progress");
    }

    notes.push(`${scenario.name}: ${problems.length === 0 ? "pass" : problems.join(", ")}`);
    if (problems.length > 0) findings.push(finding(`Native learn scenario failed: ${scenario.name}`, problems.join("; "), log));
    rmSync(sandbox, { recursive: true, force: true });
  }

  return { name: "native source terminal flows", cases: scenarios.length, durationMs: Math.round(performance.now() - started), findings, notes };
}

async function runDockerCampaign(): Promise<CampaignResult> {
  const started = performance.now();
  const findings: ExplorationFinding[] = [];
  const notes: string[] = [];
  const image = process.env.AIFIRST_NATIVE_DOCKER_IMAGE ?? "aifirst:native-explore";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const binary = `/src/bin/aifirst-linux-${arch}`;
  let cases = 0;

  const build = await commandResult([
    "docker", "build", "--target", "test",
    "--build-arg", `BUN_TARGET=bun-linux-${arch}`,
    "--build-arg", `BINARY=aifirst-linux-${arch}`,
    "--tag", image, ".",
  ], { cwd: root, timeoutMs: 600_000 });
  const buildLog = artifact("native-docker-build.log", `${build.stdout}\n${build.stderr}`);
  cases++;
  if (build.exitCode !== 0) {
    findings.push(finding("Native Docker image failed to build", `exit ${build.exitCode}`, buildLog));
    return { name: "native compiled Docker flows", cases, durationMs: Math.round(performance.now() - started), findings, notes };
  }

  const probe = await commandResult([
    "docker", "run", "--rm", "--entrypoint", "/bin/sh", image, "-c",
    "python3 -c 'import pygame, PIL' && java -version >/dev/null 2>&1 && javac -version && mvn -version >/dev/null",
  ], { cwd: root, timeoutMs: 60_000 });
  const probeLog = artifact("native-docker-runtime.log", `${probe.stdout}\n${probe.stderr}`);
  cases++;
  if (probe.exitCode !== 0) findings.push(finding("Docker learning runtimes are incomplete", `exit ${probe.exitCode}`, probeLog));
  else notes.push("Docker has Python, pygame, Pillow, java, javac, and Maven");

  const dockerScenarios = [
    { name: "java-hello", answers: ["java", "1", "run", "exit"], expect: ["Lessoncomplete", "Hello,World!"] },
    {
      name: "duckling-full-replay",
      answers: ["py", "py-9-01", "1", "2", "2", "1", "1", "finish", "exit"],
      expect: ["Lessoncomplete", "Thefinalrunwasskipped"],
      reject: ["replaystopped", "didnotmatchthecapturedresult"],
    },
    {
      name: "unsupported-plan-choice-stops-immediately",
      answers: ["py", "py-9-01", "2", "3", "4"],
      expect: ["ThischoiceneedsanLLM", "Planningendedwithoutchangingfiles"],
      reject: ["Whatshouldmakethesearchchallenging", "Whatvisualstyle"],
    },
    {
      name: "java-pocketcfo-sanitized-workspace",
      answers: ["java", "java-11-01", "1", "3", "exit"],
      expect: ["Thisdirectorymatchesyourbook'spattern", "Planningendedwithoutchangingfiles"],
      reject: ["didnotmatchthecapturedresult", "Replaystopped"],
    },
    {
      name: "java-pocketcfo-layer1-full-replay",
      answers: ["java", "java-11-01", "4", "4", "1", "1", "1", "finish", "exit"],
      expect: ["Lessoncomplete", "TransactionRepositoryTest.java"],
      reject: ["didnotmatchthecapturedresult", "Replaystopped", "mvn:commandnotfound"],
    },
    {
      name: "next-exercise-introduction-and-diffs",
      answers: ["py", "py-9-01", "1", "2", "2", "1", "1", "finish", "next", "finish", "exit"],
      expect: ["Lessoncomplete", "py-9-02:AddaFoxEnemy"],
      reject: ["replaystopped", "didnotmatchthecapturedresult"],
      after: {
        marker: "py-9-02:AddaFoxEnemy",
        expect: ["---a/constants.py", "+++b/constants.py"],
        reject: ["Code-`constants.py`"],
      },
    },
    {
      name: "level-editor-full-replay",
      answers: ["py", "py-10-01", "1", "1", "1", "1", "finish", "exit"],
      expect: ["Lessoncomplete", "leveleditor"],
      reject: ["replaystopped", "didnotmatchthecapturedresult"],
    },
    {
      name: "python-chapters-9-10-continuous",
      answers: [
        "py", "py-9-01", "1", "2", "2", "1", "1", "finish",
        "next", "finish",
        "next", "1", "2", "2", "1", "finish",
        "next", "1", "1", "1", "1", "finish",
        "next", "1", "finish",
        "next", "1", "1", "1", "finish", "exit",
      ],
      expect: [
        "py-9-01:SavetheDuckling",
        "py-10-01:DesignaLevelEditor",
        "py-10-02:AddUndoandRedo",
        "py-10-03:AnimateaBeatabilityPathfinder",
      ],
      reject: [
        "replaystopped",
        "didnotmatchthecapturedresult",
        "self-containedbuildpath",
        "capturedpy-10",
      ],
    },
    {
      name: "duckling-protects-existing-main",
      answers: ["py-9-01", "1", "2", "2", "1", "1", "2", "6"],
      expect: ["alreadyexistswithdifferentcontents", "Lessonpaused"],
      reject: ["Lessoncomplete"],
      setup: [
        "mkdir -p /tmp/state /tmp/workspace",
        `printf '%s' '${JSON.stringify({ version: 1, book: book("py").id, workspaces: { py: "/tmp/workspace" } })}' > /tmp/state/config.json`,
        `printf '%s\\n' 'print("learner file")' > /tmp/workspace/main.py`,
      ].join(" && "),
    },
  ];
  for (const scenario of dockerScenarios) {
    const common = [
      "docker", "run", "--rm", "-i",
      "--volume", `${join(root, "test")}:/src/test:ro`,
      "--env", "AIFIRST_STATE_DIR=/tmp/state",
      "--env", "AIFIRST_HOME_OVERRIDE=/tmp/home",
      "--env", "AIFIRST_LEARN_CHARS_PER_SECOND=0",
      "--env", `AIFIRST_LEARN_TEST_ANSWERS=${JSON.stringify(scenario.answers)}`,
      "--env", `AIFIRST_LEARN_TEST_TIMEOUT_SECONDS=${[
        "java-pocketcfo-layer1-full-replay",
        "python-chapters-9-10-continuous",
      ].includes(scenario.name) ? "300" : "75"}`,
      "--env", "NO_COLOR=1",
    ];
    const command = scenario.setup
      ? [
          ...common,
          "--entrypoint", "/bin/sh", image, "-c",
          `${scenario.setup} && exec python3 /src/test/fixtures/native-learn-driver.py ${binary} learn --plain --no-animation`,
        ]
      : [
          ...common,
          "--entrypoint", "python3", image,
          "/src/test/fixtures/native-learn-driver.py", binary, "learn", "--plain", "--no-animation",
        ];
    const result = await commandResult(command, {
      cwd: root,
      timeoutMs: scenario.name === "java-pocketcfo-layer1-full-replay" ? 330_000 : 90_000,
    });
    const log = artifact(`native-docker-${scenario.name}.log`, `${result.stdout}\n${result.stderr}`);
    const visible = compact(`${result.stdout}\n${result.stderr}`).toLowerCase();
    const problems: string[] = [];
    if (result.exitCode !== 0) problems.push(`exit ${result.exitCode}`);
    for (const expected of scenario.expect) if (!visible.includes(expected.toLowerCase())) problems.push(`missing ${expected}`);
    for (const rejected of scenario.reject ?? []) if (visible.includes(rejected.toLowerCase())) problems.push(`unexpected ${rejected}`);
    if (scenario.after) {
      const marker = visible.indexOf(scenario.after.marker.toLowerCase());
      if (marker < 0) problems.push(`missing marker ${scenario.after.marker}`);
      else {
        const remainder = visible.slice(marker);
        for (const expected of scenario.after.expect ?? []) {
          if (!remainder.includes(expected.toLowerCase())) problems.push(`missing after marker ${expected}`);
        }
        for (const rejected of scenario.after.reject ?? []) {
          if (remainder.includes(rejected.toLowerCase())) problems.push(`unexpected after marker ${rejected}`);
        }
      }
    }
    notes.push(`${scenario.name}: ${problems.length === 0 ? "pass" : problems.join(", ")}`);
    if (problems.length > 0) findings.push(finding(`Docker learn scenario failed: ${scenario.name}`, problems.join("; "), log));
    cases++;
  }

  const rerunRoot = mkdtempSync(join(tmpdir(), "aifirst-duckling-rerun-"));
  const rerunState = join(rerunRoot, "state");
  const rerunWorkspace = join(rerunRoot, "workspace");
  mkdirSync(rerunState);
  mkdirSync(rerunWorkspace);
  writeFileSync(join(rerunState, "config.json"), JSON.stringify({
    version: 1,
    book: book("py").id,
    workspaces: { py: "/workspace" },
  }));
  const runDuckling = (answers: string[]) => commandResult([
    "docker", "run", "--rm", "-i",
    "--volume", `${join(root, "test")}:/src/test:ro`,
    "--volume", `${rerunState}:/state`,
    "--volume", `${rerunWorkspace}:/workspace`,
    "--env", "AIFIRST_STATE_DIR=/state",
    "--env", "AIFIRST_HOME_OVERRIDE=/tmp/home",
    "--env", "AIFIRST_LEARN_CHARS_PER_SECOND=0",
    "--env", `AIFIRST_LEARN_TEST_ANSWERS=${JSON.stringify(answers)}`,
    "--env", "NO_COLOR=1",
    "--entrypoint", "python3", image,
    "/src/test/fixtures/native-learn-driver.py", binary, "learn", "--plain", "--no-animation",
  ], { cwd: root, timeoutMs: 90_000 });
  const rerunAnswers = ["py-9-01", "1", "2", "2", "1", "1", "finish", "exit"];
  const firstDuckling = await runDuckling(rerunAnswers);
  const secondDuckling = await runDuckling(rerunAnswers);
  const rerunLog = artifact(
    "native-docker-duckling-rerun.log",
    `FIRST\n${firstDuckling.stdout}\n${firstDuckling.stderr}\nSECOND\n${secondDuckling.stdout}\n${secondDuckling.stderr}`,
  );
  const rerunVisible = compact(`${secondDuckling.stdout}\n${secondDuckling.stderr}`).toLowerCase();
  const rerunProblems: string[] = [];
  if (firstDuckling.exitCode !== 0) rerunProblems.push(`first exit ${firstDuckling.exitCode}`);
  if (secondDuckling.exitCode !== 0) rerunProblems.push(`second exit ${secondDuckling.exitCode}`);
  if (!rerunVisible.includes("lessoncomplete")) rerunProblems.push("missing second completion");
  if (rerunVisible.includes("alreadyexistswithdifferentcontents")) rerunProblems.push("rerun treated authored output as learner work");
  notes.push(`duckling-rerun-is-idempotent: ${rerunProblems.length === 0 ? "pass" : rerunProblems.join(", ")}`);
  if (rerunProblems.length > 0) findings.push(finding("Duckling replay is not idempotent", rerunProblems.join("; "), rerunLog));
  cases++;
  await commandResult([
    "docker", "run", "--rm",
    "--volume", `${rerunState}:/state`,
    "--volume", `${rerunWorkspace}:/workspace`,
    "--entrypoint", "/bin/sh", image, "-c", "chmod -R a+rwX /state /workspace",
  ], { cwd: root, timeoutMs: 30_000 });
  rmSync(rerunRoot, { recursive: true, force: true });

  const tuiScenarioPath = join(outputDir, "native-docker-tui-scenario.json");
  writeFileSync(tuiScenarioPath, JSON.stringify({
    columns: 110,
    rows: 36,
    timeoutSeconds: 90,
    actions: [
      { wait: "Which book are you reading?", down: 1, enter: true },
      { wait: "What would you like to do?", text: "py-9-01", enter: true },
      { wait: "What style of gameplay", enter: true },
      { wait: "What should make the search challenging", down: 1, enter: true },
      { wait: "What visual style", down: 1, enter: true },
      { wait: "Generate simple PNG sprites programmatically", enter: true },
      { wait: "Approve this plan?", enter: true },
      { wait: "Your program is ready", enter: true },
      { wait: "Program running in another window", escape: true },
      { wait: "The program did not run cleanly", down: 1, enter: true },
      { wait: "Lesson complete", down: 3, enter: true },
    ],
  }));
  const tui = await commandResult([
    "docker", "run", "--rm", "-i",
    "--volume", `${join(root, "test")}:/src/test:ro`,
    "--volume", `${tuiScenarioPath}:/tmp/tui-scenario.json:ro`,
    "--env", "TERM=xterm-256color",
    "--env", "AIFIRST_STATE_DIR=/tmp/state",
    "--env", "AIFIRST_HOME_OVERRIDE=/tmp/home",
    "--env", "AIFIRST_LEARN_CHARS_PER_SECOND=0",
    "--env", "AIFIRST_AUTOCLOSE_PYGAME=1",
    "--env", "PYTHONPATH=/src/test/fixtures",
    "--env", "SDL_VIDEODRIVER=dummy",
    "--entrypoint", "python3", image,
    "/src/test/fixtures/native-tui-driver.py", "/tmp/tui-scenario.json", binary, "learn", "--no-animation",
  ], { cwd: root, timeoutMs: 120_000 });
  const tuiLog = artifact("native-docker-opentui.log", `${tui.stdout}\n${tui.stderr}`);
  const tuiVisible = compact(`${tui.stdout}\n${tui.stderr}`);
  const tuiProblems: string[] = [];
  if (tui.exitCode !== 0) tuiProblems.push(`exit ${tui.exitCode}`);
  for (const expected of [
    "ProposedPlan",
    "Approvethisplan?",
    "Nofileshavebeenchangedyet.",
    "Yourprogramisready",
    "Programrunninginanotherwindow",
    "Theprogramdidnotruncleanly",
    "Lessoncomplete",
    "Finishwithoutrunning",
  ]) {
    if (!tuiVisible.includes(expected)) tuiProblems.push(`missing ${expected}`);
  }
  if (!/\x1b\[48;5;235m/.test(tui.stdout)) tuiProblems.push("missing plan background color");
  if ((tui.stdout.match(/\x1b\[\?1049h/g)?.length ?? 0) !== 1) tuiProblems.push("TUI left and re-entered alternate screen");
  if ((tui.stdout.match(/\x1b\[\?1049l/g)?.length ?? 0) !== 1) tuiProblems.push("alternate screen was not restored once");
  notes.push(`opentui-duckling: ${tuiProblems.length === 0 ? "pass" : tuiProblems.join(", ")}`);
  if (tuiProblems.length > 0) findings.push(finding("Compiled OpenTUI Duckling scenario failed", tuiProblems.join("; "), tuiLog));
  cases++;

  return { name: "native compiled Docker flows", cases, durationMs: Math.round(performance.now() - started), findings, notes };
}

const campaigns = [
  await runSourceCampaign(),
  ...(process.env.AIFIRST_NATIVE_SKIP_DOCKER === "1" ? [] : [await runDockerCampaign()]),
];
const findings = campaigns.flatMap((campaign) => campaign.findings);
const report: ExplorationReport = {
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  cliVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  claudeVersion: "not used by native exploration",
  campaigns,
  findings,
};
const paths = writeExplorationReport(report, outputDir);
console.log(JSON.stringify({ report: paths, campaigns, findings: findings.length }, null, 2));
if (findings.length > 0) process.exitCode = 1;
