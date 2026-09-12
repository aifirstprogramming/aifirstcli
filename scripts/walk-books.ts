#!/usr/bin/env bun
/** Walk every authored step through the compiled CLI using persistent book workspaces. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveContent } from "../src/content";
import type { Book, ReplayStep } from "../src/content/types";
import { currentTarget, assetNameFor } from "../src/platform";
import { VERSION } from "../src/version";

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const target = currentTarget();
const binary = resolve(value("--binary") ?? (target ? join("bin", assetNameFor(target)) : "bin/aifirst"));
const reportPath = resolve(value("--report") ?? join("test-results", "book-walk", "report.json"));
const selectedBook = value("--book");
const fromStep = value("--from");
const skipSmoke = args.includes("--skip-smoke");
const keepWorkspace = args.includes("--keep-workspace");
const campaignRoot = mkdtempSync(join(tmpdir(), "aifirst-book-walk-cli-"));
const { content, version: contentVersion } = resolveContent();

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface StepResult {
  book: string;
  id: string;
  mode: string;
  command: string;
  status: "passed" | "failed" | "not-run";
  durationMs: number;
  output?: string;
  files?: string[];
}

interface SmokeResult {
  id: string;
  title: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  output?: string;
}

function bounded(value: string, limit = 40): string {
  const lines = value.split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(-limit).join("\n");
}

function stopProcess(proc: ReturnType<typeof Bun.spawn>): void {
  if (proc.exitCode !== null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, "SIGTERM");
      return;
    } catch {
      // Fall through to the direct child.
    }
  }
  proc.kill("SIGTERM");
}

async function command(
  argv: string[],
  options: { cwd: string; env: Record<string, string | undefined>; timeoutMs?: number },
): Promise<CommandResult> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  const timer = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        stopProcess(proc);
      }, options.timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (timer) clearTimeout(timer);
  return { exitCode: proc.exitCode ?? 1, stdout, stderr, timedOut };
}

function baseEnv(home: string, state: string): Record<string, string | undefined> {
  return {
    ...process.env,
    AIFIRST_HOME_OVERRIDE: home,
    AIFIRST_STATE_DIR: state,
    AIFIRST_BOOK_WALK: "1",
    AIFIRST_TUI: "0",
    NO_COLOR: "1",
  };
}

function bookWorkspace(home: string, book: Book): string {
  const workspace = join(home, "aifirst", book.tag);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

async function runStep(book: Book, step: ReplayStep, home: string, state: string): Promise<StepResult> {
  const started = performance.now();
  const external = step.execution.launch?.surface === "external";
  const argv = external
    ? [binary, "replay", "execute", step.id, "--relax-output", "--format", "json"]
    : [binary, "run", step.id, "--yes", "--format", "json"];
  const env = baseEnv(home, state);
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const result = await command(argv, {
    cwd: external ? bookWorkspace(home, book) : campaignRoot,
    env,
    timeoutMs: 600_000,
  });
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    // Failure output below retains the raw process streams.
  }
  const identified = external ? parsed?.exerciseId === step.id : parsed?.stepId === step.id;
  const ok = result.exitCode === 0 && !result.timedOut && identified && (
    external ? parsed?.ok === true : (parsed?.ran as { ok?: boolean } | undefined)?.ok === true
  );
  const files = external
    ? (parsed?.files as string[] | undefined)
    : [parsed?.path, ...((parsed?.scaffold as string[] | undefined) ?? [])].filter((item): item is string => typeof item === "string");
  return {
    book: book.tag,
    id: step.id,
    mode: step.execution.mode,
    command: argv.slice(1).join(" "),
    status: ok ? "passed" : "failed",
    durationMs: Math.round(performance.now() - started),
    ...(files?.length ? { files } : {}),
    ...(!ok ? { output: bounded(`${result.stdout}\n${result.stderr}`) } : {}),
  };
}

async function graphicalSmoke(
  id: string,
  title: string,
  expectedWindowTitle: string,
  close: "escape" | "terminate",
  timeoutMs: number,
): Promise<SmokeResult> {
  const started = performance.now();
  if (skipSmoke) return { id, title, status: "skipped", durationMs: 0, output: "Skipped by --skip-smoke." };
  if (!process.env.DISPLAY) return { id, title, status: "failed", durationMs: 0, output: "DISPLAY is not set." };
  const smokeRoot = join(campaignRoot, "smoke", id);
  const home = join(smokeRoot, "home");
  const state = join(smokeRoot, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  const proc = Bun.spawn([binary, "run", id, "--yes", "--no-timeout", "--format", "json"], {
    cwd: smokeRoot,
    env: baseEnv(home, state),
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let windowId: string | undefined;
  let observedTitles: string[] = [];
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline && proc.exitCode === null) {
    // SDL only sets WM_NAME under Xvfb, while xdotool's --name search checks
    // _NET_WM_NAME. Enumerate visible client windows by class, then verify the
    // title through xdotool's WM_NAME-compatible getwindowname fallback.
    const search = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--class", ".*"], {
      env: process.env,
      stdout: "pipe",
      stderr: "ignore",
    });
    const candidates = search.stdout.toString().trim().split(/\s+/).filter(Boolean);
    observedTitles = [];
    for (const candidate of candidates) {
      const name = Bun.spawnSync(["xdotool", "getwindowname", candidate], {
        env: process.env,
        stdout: "pipe",
        stderr: "ignore",
      });
      if (name.exitCode !== 0) continue;
      const candidateTitle = name.stdout.toString().trim();
      if (candidateTitle) observedTitles.push(candidateTitle);
      if (candidateTitle === expectedWindowTitle) {
        windowId = candidate;
        break;
      }
    }
    if (windowId) break;
    await Bun.sleep(500);
  }
  if (windowId) {
    if (close === "escape") {
      Bun.spawnSync(["xdotool", "key", "--window", windowId, "Escape"], {
        env: process.env,
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      // Xvfb has no window manager to deliver a normal close request. Seeing
      // the exact JavaFX title proves the real stage launched; deterministic
      // replay already verifies the program itself before this smoke check.
      stopProcess(proc);
    }
  } else {
    stopProcess(proc);
  }
  const exitDeadline = performance.now() + 15_000;
  while (proc.exitCode === null && performance.now() < exitDeadline) await Bun.sleep(250);
  if (proc.exitCode === null) stopProcess(proc);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  let ranOk = false;
  try {
    ranOk = (JSON.parse(stdout) as { ran?: { ok?: boolean } }).ran?.ok === true;
  } catch {
    // Raw output is included in the failure report.
  }
  const ok = Boolean(windowId && (close === "terminate" || (ranOk && proc.exitCode === 0)));
  return {
    id,
    title,
    status: ok ? "passed" : "failed",
    durationMs: Math.round(performance.now() - started),
    ...(!ok ? {
      output: bounded([
        `Expected window title: ${expectedWindowTitle}`,
        `Observed window titles: ${observedTitles.length ? observedTitles.join(", ") : "none"}`,
        `CLI exit code: ${proc.exitCode ?? "none"}`,
        stdout,
        stderr,
      ].join("\n")),
    } : {}),
  };
}

const versionResult = await command([binary, "--version"], {
  cwd: campaignRoot,
  env: baseEnv(join(campaignRoot, "version-home"), join(campaignRoot, "version-state")),
  timeoutMs: 30_000,
});
const versionOk = versionResult.exitCode === 0 && versionResult.stdout.trim() === VERSION;
const steps: StepResult[] = [];
let startedWalking = fromStep === undefined;

for (const book of content.books) {
  if (selectedBook && ![book.tag, book.id].includes(selectedBook)) continue;
  const home = join(campaignRoot, "home");
  const state = join(campaignRoot, "state");
  let failed = false;
  for (const example of book.sections.flatMap((section) => section.chapters).flatMap((chapter) => chapter.examples)) {
    for (const rawStep of example.steps) {
      const step = rawStep as ReplayStep;
      if (!startedWalking) startedWalking = step.id === fromStep;
      if (!startedWalking || failed) {
        steps.push({
          book: book.tag,
          id: step.id,
          mode: step.execution.mode,
          command: "",
          status: "not-run",
          durationMs: 0,
          output: failed ? "A prior step in this book failed." : `Skipped before ${fromStep}.`,
        });
        continue;
      }
      const result = await runStep(book, step, home, state);
      steps.push(result);
      if (result.status === "failed") failed = true;
    }
  }
}

let progressOk = true;
let progressOutput = "";
if (!selectedBook && !fromStep && steps.every((step) => step.status === "passed")) {
  const progress = await command([binary, "progress", "--all", "--format", "json"], {
    cwd: campaignRoot,
    env: baseEnv(join(campaignRoot, "home"), join(campaignRoot, "state")),
    timeoutMs: 30_000,
  });
  progressOutput = `${progress.stdout}\n${progress.stderr}`;
  try {
    const parsed = JSON.parse(progress.stdout) as { overall?: { done?: number; total?: number } };
    progressOk = progress.exitCode === 0 && parsed.overall?.done === 154 && parsed.overall?.total === 154;
  } catch {
    progressOk = false;
  }
}

const smoke = [
  await graphicalSmoke("py-9-01", "Save the Duckling", "Save the Duckling", "escape", 60_000),
  await graphicalSmoke("java-11-01", "Personal Finance", "Personal Finance", "terminate", 180_000),
];
const failedSteps = steps.filter((step) => step.status === "failed");
const notRun = steps.filter((step) => step.status === "not-run");
const failedSmoke = smoke.filter((result) => result.status === "failed");
const report = {
  version: 1,
  cliVersion: VERSION,
  contentVersion,
  binary,
  workspace: campaignRoot,
  summary: {
    totalSteps: content.steps.length,
    attempted: steps.filter((step) => step.status !== "not-run").length,
    passed: steps.filter((step) => step.status === "passed").length,
    failed: failedSteps.length,
    notRun: notRun.length,
    graphicalSmokePassed: smoke.filter((result) => result.status === "passed").length,
    graphicalSmokeFailed: failedSmoke.length,
    graphicalSmokeSkipped: smoke.filter((result) => result.status === "skipped").length,
    progressOk,
    versionOk,
  },
  steps,
  smoke,
  ...(!progressOk ? { progressOutput: bounded(progressOutput) } : {}),
  ...(!versionOk ? { versionOutput: bounded(`${versionResult.stdout}\n${versionResult.stderr}`) } : {}),
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
const ok = versionOk && progressOk && failedSteps.length === 0 && notRun.length === 0 && failedSmoke.length === 0;
console.log(
  `${ok ? "PASS" : "FAIL"} book walk: ${report.summary.passed}/${report.summary.totalSteps} steps, ` +
    `${report.summary.graphicalSmokePassed}/2 graphical smokes. Report: ${reportPath}`,
);
if (!ok) console.error(`Workspace retained at ${campaignRoot}`);
if (ok && !keepWorkspace) rmSync(campaignRoot, { recursive: true, force: true });
if (!ok) process.exitCode = 1;
