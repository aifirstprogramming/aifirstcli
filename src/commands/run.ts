/**
 * `aifirst run <id>` — write the book's code, run it, and record it.
 *
 * This is what "done" means. Writing a file proves nothing; a learner has
 * finished an exercise when the program actually runs. So completion is recorded
 * here, on exit 0, and nowhere else automatic.
 *
 * stdin, in order of preference:
 *   1. the exercise's authored sample, when it reads input
 *   2. the learner's own keyboard, when attached to a real terminal
 *   3. nothing — and for an input-reading exercise that is an error, not a hang
 *
 * An assistant cannot type into a running program (Claude Code's `!` prefix does
 * not attach an interactive stdin), which is exactly why case 1 exists.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { resolve, runCommand, suggestFilename } from "@aifirst/content";
import type { Content } from "../content/types";
import { which } from "../agents/util";
import type { Args } from "../cli";
import { boolFlag, formatFlag, numberFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import type { Example, Step } from "../content/types";
import { finalResponse } from "../exercises";
import { markIfNew } from "../log/progress";
import { CliError, bold, cyan, dim, explanationBlock, glyph, green, json, out, red } from "../output";

const TIMEOUT_MS = 30_000;

/**
 * Write the extra files a non-runnable exercise needs.
 *
 * The book prints some code as a fragment: a class with no entry point, or a method
 * body shown on its own. The response stays exactly as printed, and whatever it needs
 * around it comes from the pack's scaffold. `fromExercise` points at another
 * exercise's code rather than duplicating it, so the two cannot drift apart.
 *
 * Existing files are never overwritten -- one of them may be the learner's own work.
 */
function writeScaffold(dir: string, step: Step, content: Content): string[] {
  const written: string[] = [];
  for (const file of step.scaffold?.files ?? []) {
    if (file.path.includes("..") || file.path.startsWith("/")) continue;
    const body = file.fromExercise
      ? content.steps.find((s) => s.id === file.fromExercise)?.response
      : file.content;
    if (body === undefined) continue;

    const target = resolvePath(dir, file.path);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body.endsWith("\n") ? body : `${body}\n`);
    written.push(file.path);
  }
  return written;
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
function commandsFor(example: Example, step: Step, file: string): string[][] {
  const entry = step.scaffold?.entrypoint;
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
    if (extraSources) {
      return [
        ["javac", "-d", "out", "-sourcepath", ".", runFile],
        ["java", "-cp", "out", runFile.replace(/\.java$/, "")],
      ];
    }
    return [runCommand("java", runFile) ?? ["java", runFile]];
  }
  if (entry) return [["python3", entry]];
  return [runCommand(example.language, file) ?? ["python3", file]];
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

  const body = step.response.endsWith("\n") ? step.response : step.response + "\n";
  const path = resolvePath(stringFlag(args, "into") ?? suggestFilename(example, step));
  const force = boolFlag(args, "force");

  // Write it, but never over something different that the learner wrote.
  let wrote = false;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing !== body && !force) {
      throw new CliError(
        `${path} already exists with different contents`,
        "file_exists",
        `That may be your own attempt. Pass --force to replace it, or --into <file> to use another name.`,
      );
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    wrote = true;
  }

  // Anything the exercise needs around it, written next to it.
  const scaffoldFiles = writeScaffold(dirname(path), step, content);

  const commands = commandsFor(example, step, basename(path));
  const command = commands[0];
  if (!command) {
    throw new CliError(
      `Don't know how to run ${example.language} exercises`,
      "unsupported_language",
      `The file is written at ${path}; run it yourself, then: aifirst done ${example.id}`,
    );
  }
  if (example.kind === "test" && example.language === "java" && !existsSync(junitJar())) {
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
        ? `Install a JDK (11 or newer) to run Java exercises. The file is written at ${path}.`
        : `Install Python 3 to run Python exercises. The file is written at ${path}.`,
    );
  }

  // Decide how the program gets its input.
  const interactive = step.interactive;
  const hasTty = Boolean(process.stdin.isTTY);
  if (interactive && step.stdin === undefined && !hasTty) {
    throw new CliError(
      `${step.id} reads input and has no sample, and there is no terminal attached`,
      "needs_interactive_run",
      `Ask the learner to run it themselves: aifirst run ${step.id}`,
    );
  }
  const useTty = interactive && step.stdin === undefined && hasTty;

  // Run each command in turn; a failed compile stops the sequence.
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  let timedOut = false;
  let ranProgram = false;

  for (let n = 0; n < commands.length; n++) {
    const argv = commands[n];
    const last = n === commands.length - 1;
    const proc = Bun.spawn(argv, {
      cwd: dirname(path),
      stdin:
        useTty && last
          ? "inherit"
          : step.stdin === undefined || !last
            ? "ignore"
            : new TextEncoder().encode(step.stdin),
      stdout: useTty && last ? "inherit" : "pipe",
      stderr: useTty && last ? "inherit" : "pipe",
    });

    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const [o, e] =
      useTty && last
        ? ["", ""]
        : await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);

    stdout += o;
    stderr += e;
    exitCode = proc.exitCode;
    timedOut = proc.exitCode === null;
    ranProgram = last;
    if (proc.exitCode !== 0) break;
  }

  const output = `${stdout}${stderr}`.replace(/\n$/, "");

  // Some exercises teach error handling by throwing on purpose, and the book says so.
  // Treating that as failure would refuse to record an exercise that worked exactly
  // as printed.
  const deliberate =
    step.expectsException === true && ranProgram && exitCode !== 0 && !timedOut && stdout.trim() !== "";
  const ok = exitCode === 0 || deliberate;

  // The whole point: only a clean run records progress.
  const recorded = ok ? markIfNew(example.id, { via: "run" }) : null;

  if (format === "json") {
    json({
      exerciseId: example.id,
      stepId: step.id,
      path,
      wrote,
      ran: { ok, exitCode, timedOut, stdout, stderr, commands: commands.map((c) => c.join(" ")) },
      ...(scaffoldFiles.length > 0 ? { scaffold: scaffoldFiles } : {}),
      ...(step.stdin === undefined ? {} : { stdin: step.stdin }),
      recorded: recorded !== null,
    });
    if (!ok) process.exitCode = 1;
    return;
  }

  out();
  out(`  ${wrote ? green(glyph.done) : dim(glyph.done)} ${wrote ? "wrote" : "using"} ${bold(path)}  ${dim(step.id)}`);
  if (scaffoldFiles.length > 0) {
    out(dim(`  also wrote ${scaffoldFiles.join(", ")} — the code this exercise needs around it`));
  }
  if (step.stdin !== undefined) {
    out(dim(`  input: ${JSON.stringify(step.stdin)}`));
  }

  if (!useTty) {
    out();
    for (const line of output.split("\n")) out(`  ${line}`);
  }
  out();

  if (ok) {
    out(
      recorded
        ? `  ${green(glyph.done)} ${deliberate ? "threw as the book intends" : "ran clean"} — recorded ${bold(example.id)} as done`
        : `  ${green(glyph.done)} ${deliberate ? "threw as the book intends" : "ran clean"} — ${dim(`${example.id} was already recorded`)}`,
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
      timedOut ? `still running after ${TIMEOUT_MS / 1000}s` : `exited ${exitCode}`
    } — not recorded`,
  );
  out(dim(`  ${cyan(glyph.arrow)} fix it and run again, or: aifirst done ${example.id}`));
  out();
  process.exitCode = 1;
}
