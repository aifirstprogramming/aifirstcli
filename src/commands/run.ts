/**
 * `aifirst run <id>` — write the book's code, run it, and record it.
 *
 * This is what "done" means. Writing a file proves nothing; a learner has
 * finished an exercise when its authored compile, test, build, or run check
 * succeeds. Completion is recorded here, on that verified outcome.
 *
 * stdin, in order of preference:
 *   1. the exercise's authored sample, when it reads input
 *   2. the learner's own keyboard, when attached to a real terminal
 *   3. nothing — and for an input-reading exercise that is an error, not a hang
 *
 * An assistant cannot type into a running program (Claude Code's `!` prefix does
 * not attach an interactive stdin), which is exactly why case 1 exists.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { exercisePath, resolve, runCommand } from "@aifirst/content";
import type { Content } from "../content/types";
import { which } from "../agents/util";
import type { Args } from "../cli";
import { boolFlag, formatFlag, numberFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import { writeScaffold } from "../content/scaffold";
import type { Example, Execution, ExecutionMode, Step } from "../content/types";
import { GeneratedFileStore } from "../generatedFiles";
import { preflightDependencies } from "./dependencies";
import type { PythonRuntime } from "../dependencies";
import { withPythonRuntime } from "../dependencies";
import { finalResponse } from "../exercises";
import { markIfNew } from "../log/progress";
import { CliError, bold, codeBlock, cyan, dim, explanationBlock, glyph, green, json, out, red } from "../output";
import { defaultExercisePath } from "../workspace";
import { runAsyncProcess, type ProcessInput } from "../process";

const PROGRAM_TIMEOUT_MS = 30_000;
const VERIFICATION_TIMEOUT_MS = 180_000;

export function runTimeoutMs(
  args: Args,
  execution?: Execution,
  commandIndex = 0,
  commandCount = 1,
): number | undefined {
  return executionTimeoutMs(boolFlag(args, "no-timeout"), execution, commandIndex, commandCount);
}

function executionTimeoutMs(
  noTimeout: boolean,
  execution?: Execution,
  commandIndex = 0,
  commandCount = 1,
): number | undefined {
  if (noTimeout) return undefined;
  const finalLaunch = execution?.launch && commandIndex === commandCount - 1
    ? execution.launch
    : undefined;
  if (finalLaunch?.surface === "external") return undefined;
  return finalLaunch ? PROGRAM_TIMEOUT_MS : execution ? VERIFICATION_TIMEOUT_MS : PROGRAM_TIMEOUT_MS;
}

/** Trailing-newline differences are not a difference in the code. */
function sameCode(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n").replace(/\n+$/, "") === b.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/**
 * Which exercise's canonical code is this, if any?
 *
 * Used to tell "the tool wrote this for the previous exercise" from "the learner
 * wrote this themselves". The first is safe to replace; the second is the most
 * valuable thing in the directory.
 */
function canonicalOwner(text: string, content: Content): string | undefined {
  return content.steps.find((s) => sameCode(s.response, text))?.id;
}

/**
 * Where the JUnit console launcher lives.
 *
 * Java test exercises run through it rather than a build tool, so the books need no
 * pom.xml and a learner needs no Maven. It is not bundled: it is a 2.6 MB jar, and
 * fetching it silently at run time would be a surprise. `aifirst doctor` explains how
 * to get it, and running a test exercise without it says so plainly.
 */
export function junitJar(): string {
  return process.env.AIFIRST_JUNIT_JAR ?? join(homedir(), ".aifirst-toolcache", "junit-console.jar");
}

export const JUNIT_URL =
  "https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/1.10.2/" +
  "junit-platform-console-standalone-1.10.2.jar";

/**
 * How to run this exercise here.
 *
 * Java needs a compile step whenever the scaffold supplies other sources: the
 * single-file launcher only pulls in siblings on JDK 22 and later, and a learner on
 * an LTS release would otherwise see "cannot find symbol" for code that is right.
 */
export function commandsFor(example: Example, step: Step, file: string, python?: PythonRuntime): string[][] {
  if (step.execution.commands?.length) return step.execution.commands;
  const entry = step.execution.entrypoint;
  if (example.language === "java") {
    if (example.kind === "test") {
      const jar = junitJar();
      const cls = file.replace(/\.java$/, "");
      return [
        ["javac", "-cp", `${jar}:.`, "-sourcepath", ".", "-d", "out", file],
        ["java", "-jar", jar, "execute", "-cp", "out", "--select-class", cls, "--details=summary"],
      ];
    }
    const extraSources = (step.scaffold?.files ?? []).some((f) => f.path.endsWith(".java"));
    const runFile = entry ?? file;
    const hasMain = entry !== undefined || /static\s+void\s+main\s*\(/.test(step.response);
    if (!hasMain) return [["javac", "-d", "out", file]];
    if (extraSources) {
      return [
        ["javac", "-d", "out", "-sourcepath", ".", runFile],
        ["java", "-cp", "out", runFile.replace(/\.java$/, "")],
      ];
    }
    return [runCommand("java", runFile) ?? ["java", runFile]];
  }
  // A bare "-" means stdin to Python, but --into - intentionally creates a
  // file with that name. Prefix it so every launcher treats it as a path.
  const runFile = file === "-" ? "./-" : file;
  const command = entry ? ["python3", entry] : (runCommand(example.language, runFile) ?? ["python3", runFile]);
  return [python ? withPythonRuntime(command, python) : command];
}

export function executionMode(_example: Example, step: Step): ExecutionMode {
  return step.execution.mode;
}

export function executionSuccessText(mode: ReturnType<typeof executionMode>): string {
  if (mode === "compile") return "compiled clean";
  if (mode === "test") return "tests passed";
  if (mode === "build") return "built clean";
  return "ran clean";
}

/** Pick the step to run, honouring --step and a step-level id. */
function pickStep(args: Args, example: Example, addressed?: Step): Step {
  const stepNumber = numberFlag(args, "step");
  if (stepNumber !== undefined) {
    const found = example.steps.find((s) => s.index === stepNumber);
    if (!found) {
      throw new CliError(
        `${example.id} has ${example.steps.length} step(s); there is no step ${stepNumber}`,
        "unknown_step",
      );
    }
    return found;
  }
  // A whole multi-step example runs its final step: the steps are progressive,
  // so earlier ones are half-built versions of the same program.
  return addressed ?? finalResponse(example);
}

export interface PreparedExerciseFiles {
  path: string;
  cwd: string;
  wrote: boolean;
  replaced?: string;
  scaffoldFiles: string[];
}

export interface ExerciseRunOptions {
  runtime?: PythonRuntime;
  inputMode?: "authored-sample" | "reader";
  noTimeout?: boolean;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onInputReady?: (input: ProcessInput) => void;
}

export interface ExerciseRunResult {
  ok: boolean;
  deliberate: boolean;
  recorded: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  timedOutAfterMs?: number;
  commands: string[][];
  aborted: boolean;
}

/** Safely materialize an exercise without executing or recording it. */
export function prepareExerciseFiles(
  content: Content,
  example: Example,
  step: Step,
  options: { into?: string; force?: boolean; generatedFiles?: GeneratedFileStore } = {},
): PreparedExerciseFiles {
  const body = step.response.endsWith("\n") ? step.response : step.response + "\n";
  const path = resolvePath(options.into ?? exercisePath(example, step));
  const scaffold = step.scaffold as typeof step.scaffold & { projectRoot?: string; responsePath?: string; clean?: string[] };
  const responseDirectory = scaffold?.responsePath ? dirname(scaffold.responsePath) : ".";
  const projectRoot = scaffold?.projectRoot
    ? resolvePath(dirname(path), ...responseDirectory.split(/[\\/]+/).filter((part) => part && part !== ".").map(() => ".."))
    : dirname(path);
  const generatedFiles = options.generatedFiles ?? new GeneratedFileStore();

  if (scaffold?.projectRoot) {
    const desired = new Set([
      resolvePath(path),
      ...(scaffold.files ?? [])
        .filter((file) => !file.path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(file.path) && !file.path.split(/[\\/]+/).includes(".."))
        .map((file) => resolvePath(projectRoot, file.path)),
    ]);
    const missingRecords: string[] = [];
    const obsoleteFiles: string[] = [];
    for (const record of generatedFiles.recordsUnder(projectRoot)) {
      if (desired.has(record.path)) continue;
      if (!existsSync(record.path)) {
        missingRecords.push(record.path);
      } else if (generatedFiles.matches(record.path)) {
        obsoleteFiles.push(record.path);
      } else {
        throw new CliError(
          `${record.path} belongs to an earlier project checkpoint but now contains your changes`,
          "checkpoint_conflict",
          "It was left alone. Move it outside the project or restore the AI First version, then run this exercise again.",
        );
      }
    }
    for (const record of missingRecords) generatedFiles.forget(record);
    for (const obsolete of obsoleteFiles) {
      unlinkSync(obsolete);
      generatedFiles.forget(obsolete);
    }
  }

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    const previous = canonicalOwner(existing, content);
    if (!sameCode(existing, body) && !options.force && !previous && !generatedFiles.matches(path)) {
      throw new CliError(
        `${path} already exists with different contents`,
        "file_exists",
        `That looks like your own work, so it was left alone. Replace it with ` +
          `--force, or write this exercise somewhere else with --into <file>.`,
      );
    }
  }

  const cleanTargets: string[] = [];
  for (const cleanPath of scaffold?.clean ?? []) {
    if (cleanPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cleanPath) || cleanPath.split(/[\\/]+/).includes("..")) {
      throw new CliError(`Unsafe project cleanup path ${cleanPath}`, "unsafe_path");
    }
    const target = resolvePath(projectRoot, cleanPath);
    if (!existsSync(target)) continue;
    const previous = canonicalOwner(readFileSync(target, "utf8"), content);
    if (!previous && !generatedFiles.matches(target)) {
      throw new CliError(
        `${target} must be removed to restore this project checkpoint`,
        "file_exists",
        "It does not match AI First's generated copy, so it was left alone.",
      );
    }
    cleanTargets.push(target);
  }
  for (const target of cleanTargets) {
    unlinkSync(target);
    generatedFiles.forget(target);
  }
  let wrote = false;
  let replaced: string | undefined;

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    const previous = canonicalOwner(existing, content);
    if (sameCode(existing, body)) {
      // Already exactly this exercise's code.
      generatedFiles.record(path);
    } else if (options.force || previous || generatedFiles.matches(path)) {
      writeFileSync(path, body);
      generatedFiles.record(path);
      wrote = true;
      replaced = previous;
    } else {
      throw new CliError(
        `${path} already exists with different contents`,
        "file_exists",
        `That looks like your own work, so it was left alone. Replace it with ` +
          `--force, or write this exercise somewhere else with --into <file>.`,
      );
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    generatedFiles.record(path);
    wrote = true;
  }

  const scaffoldFiles = writeScaffold(projectRoot, step, content, { generatedFiles });
  return { path, cwd: projectRoot, wrote, ...(replaced ? { replaced } : {}), scaffoldFiles };
}

/** Execute already-prepared exercise files with either deterministic or reader-provided input. */
export async function executePreparedExercise(
  example: Example,
  step: Step,
  prepared: PreparedExerciseFiles,
  options: ExerciseRunOptions = {},
): Promise<ExerciseRunResult> {
  const commands = commandsFor(example, step, basename(prepared.path), options.runtime);
  const command = commands[0];
  if (!command) {
    throw new CliError(
      `Don't know how to run ${example.language} exercises`,
      "unsupported_language",
      `The file is written at ${prepared.path}; run it yourself, then: aifirst done ${example.id}`,
    );
  }
  const usesJunitLauncher = commands.some((candidate) => candidate.includes(junitJar()));
  if (usesJunitLauncher && !existsSync(junitJar())) {
    throw new CliError(
      `${example.id} is a JUnit test and the JUnit launcher is not installed`,
      "missing_junit",
      `Fetch it once, then run this again:\n` +
        `    mkdir -p ${dirname(junitJar())}\n` +
        `    curl -sSLo ${junitJar()} ${JUNIT_URL}`,
    );
  }
  if (!which(command[0])) {
    throw new CliError(
      `${command[0]} is not installed`,
      "missing_runtime",
      example.language === "java"
        ? `Install a JDK (11 or newer) to run Java exercises. The file is written at ${prepared.path}.`
        : `Install Python 3 to run Python exercises. The file is written at ${prepared.path}.`,
    );
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let timedOut = false;
  let timedOutAfterMs: number | undefined;
  let aborted = false;
  let ranProgram = false;

  for (let index = 0; index < commands.length; index++) {
    const argv = commands[index]!;
    const last = index === commands.length - 1;
    const readerInput = last && step.interactive && options.inputMode === "reader";
    const timeoutMs = readerInput
      ? undefined
      : executionTimeoutMs(Boolean(options.noTimeout), step.execution, index, commands.length);
    const result = await runAsyncProcess(argv, {
      cwd: prepared.cwd,
      stdin: readerInput
        ? options.onInputReady ? "interactive" : "inherit"
        : last && step.stdin !== undefined
          ? step.stdin
          : "ignore",
      timeoutMs,
      signal: options.signal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      onInputReady: readerInput ? options.onInputReady : undefined,
    });
    stdout += result.stdout;
    stderr += result.stderr;
    exitCode = result.exitCode;
    timedOut = result.timedOut;
    aborted = result.aborted;
    if (timedOut) timedOutAfterMs = timeoutMs;
    ranProgram = last;
    if (exitCode !== 0 || timedOut || aborted) break;
  }

  const deliberate = step.expectsException === true && ranProgram && exitCode !== 0 && !timedOut && stdout.trim() !== "";
  const ok = !aborted && (exitCode === 0 || deliberate);
  const recorded = ok ? markIfNew(example.id, { via: "run" }) !== null : false;
  return {
    ok,
    deliberate,
    recorded,
    stdout,
    stderr,
    exitCode,
    timedOut,
    ...(timedOutAfterMs === undefined ? {} : { timedOutAfterMs }),
    commands,
    aborted,
  };
}

export async function run(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const id = args.positionals[0];
  if (!id) {
    throw new CliError("run needs an exercise id", "missing_argument", "Try: aifirst run py-1-01");
  }

  const { content } = resolveContent();
  const hit = resolve(id, content);
  const example = hit.example;
  const step = pickStep(args, example, hit.kind === "step" ? hit.step : undefined);

  const into = stringFlag(args, "into");
  const destination = into ?? defaultExercisePath(content, example, step);
  const retryCommand = [
    "aifirst run",
    step.id,
    "--yes",
    ...(into ? ["--into", JSON.stringify(into)] : []),
    ...(boolFlag(args, "force") ? ["--force"] : []),
    ...(format === "json" ? ["--format json"] : []),
  ].join(" ");
  const dependencyReport = await preflightDependencies(args, example, step, format, retryCommand);

  const prepared = prepareExerciseFiles(content, example, step, {
    into: destination,
    force: boolFlag(args, "force"),
  });
  const { path, cwd, wrote, replaced, scaffoldFiles } = prepared;
  const body = step.response.endsWith("\n") ? step.response : step.response + "\n";

  const mode = executionMode(example, step);
  // Whatever happened above, the file about to run must hold this exercise's code.
  //
  // Recording a pass for a stale file is the one failure this command must not
  // have -- a learner banking a green tick for code that never ran is worse than
  // any error message. Before 0.3.1, `--force` skipped the refusal without writing,
  // so a previous exercise's file ran and was recorded as this one passing.
  const onDisk = readFileSync(path, "utf8");
  if (!sameCode(onDisk, body)) {
    throw new CliError(
      `${path} does not contain ${step.id}'s code, so running it would prove nothing`,
      "stale_file",
      `Write it first: aifirst run ${step.id} --force`,
    );
  }

  if (step.interactive && step.stdin === undefined && !process.stdin.isTTY) {
    throw new CliError(
      `${step.id} reads input and has no sample, and there is no terminal attached`,
      "needs_interactive_run",
      `Ask the learner to run it themselves: aifirst run ${step.id}`,
    );
  }
  const readerInput = format === "text" && step.interactive && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const renderPrepared = (showAuthoredInput: boolean) => {
    out();
    out(`  ${wrote ? green(glyph.done) : dim(glyph.done)} ${wrote ? "wrote" : "using"} ${bold(path)}  ${dim(step.id)}`);
    if (replaced) {
      out(dim(`  replaced ${replaced}'s code, which this exercise builds on`));
    }
    if (scaffoldFiles.length > 0) {
      out(dim(`  also wrote ${scaffoldFiles.join(", ")} — the code this exercise needs around it`));
    }
    if (showAuthoredInput && step.stdin !== undefined) {
      out(dim(`  input: ${JSON.stringify(step.stdin)}`));
    }

    out();
    out(`  ${cyan("Code")} ${dim(`(${example.language})`)}`);
    out(codeBlock(step.response));
  };
  if (readerInput) {
    renderPrepared(false);
    out();
    out(`  ${cyan("Interactive output")}`);
    out();
  }
  const executed = await executePreparedExercise(example, step, prepared, {
    runtime: dependencyReport.runtime,
    inputMode: readerInput ? "reader" : "authored-sample",
    noTimeout: boolFlag(args, "no-timeout"),
    onStdout: readerInput ? (chunk) => process.stdout.write(chunk) : undefined,
    onStderr: readerInput ? (chunk) => process.stderr.write(chunk) : undefined,
  });
  const { stdout, stderr, exitCode, timedOut, timedOutAfterMs, deliberate, ok, recorded, commands } = executed;
  const output = `${stdout}${stderr}`.replace(/\n$/, "");

  if (format === "json") {
    json({
      exerciseId: example.id,
      stepId: step.id,
      path,
      wrote,
      ran: { ok, exitCode, timedOut, stdout, stderr, commands: commands.map((c) => c.join(" ")) },
      execution: {
        mode,
        ok,
        commands: commands.map((c) => c.join(" ")),
        ...(step.execution.launch ? { launch: step.execution.launch } : {}),
      },
      ...(scaffoldFiles.length > 0 ? { scaffold: scaffoldFiles } : {}),
      ...(replaced ? { replaced } : {}),
      ...(step.stdin === undefined ? {} : { stdin: step.stdin }),
      recorded,
      dependencies: dependencyReport.dependencies,
    });
    if (!ok) process.exitCode = 1;
    return;
  }

  if (!readerInput) {
    renderPrepared(true);
    out();
    out(`  ${cyan("Output")}`);
    out();
    if (output) for (const line of output.split("\n")) out(`  ${line}`);
    else out(dim("  Program completed with no console output."));
  } else if (!output) {
    out(dim("  Program completed with no console output."));
  }
  out();

  if (ok) {
    out(
      recorded
        ? `  ${green(glyph.done)} ${deliberate ? "threw as the book intends" : executionSuccessText(mode)} — recorded ${bold(example.id)} as done`
        : `  ${green(glyph.done)} ${deliberate ? "threw as the book intends" : executionSuccessText(mode)} — ${dim(`${example.id} was already recorded`)}`,
    );
    if (step.explanation) {
      out();
      for (const line of explanationBlock(step.explanation)) out(line);
    }
    out();
    return;
  }

  out(
    `  ${red(glyph.todo)} ${
      timedOut ? `still running after ${(timedOutAfterMs ?? PROGRAM_TIMEOUT_MS) / 1000}s` : `exited ${exitCode}`
    } — not recorded`,
  );
  out(dim(`  ${cyan(glyph.arrow)} fix it and run again, or: aifirst done ${example.id}`));
  out();
  process.exitCode = 1;
}
