import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { $ } from "bun";
import type { Replay, ReplayOperation } from "../content/types";
import { resolvePythonRuntime, withPythonRuntime, type PythonRuntime } from "../dependencies";

export interface ReplayCommandResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  matchesExpected: boolean;
}

export interface ReplayExecution {
  files: string[];
  commands: ReplayCommandResult[];
  ok: boolean;
  text: string;
}

export interface ReplayOperationExecution {
  files: string[];
  command?: ReplayCommandResult;
  ok: boolean;
  text: string;
}

function applyEdit(operation: Extract<ReplayOperation, { type: "edit" }>, root: string): void {
  const path = inside(root, operation.path);
  const current = readFileSync(path, "utf8");
  if (!current.includes(operation.oldText)) throw new Error(`Replay edit did not find its captured text in ${operation.path}`);
  if (!operation.replaceAll && current.indexOf(operation.oldText) !== current.lastIndexOf(operation.oldText)) {
    throw new Error(`Replay edit matched more than once in ${operation.path}`);
  }
  writeFileSync(path, operation.replaceAll
    ? current.split(operation.oldText).join(operation.newText)
    : current.replace(operation.oldText, operation.newText));
}

function inside(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Replay path must be relative: ${path}`);
  const target = resolve(root, path);
  const remainder = relative(resolve(root), target);
  if (remainder === ".." || remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(remainder)) {
    throw new Error(`Replay path escapes the workspace: ${path}`);
  }
  return target;
}

export function materializeReplayCommand(
  operation: Extract<ReplayOperation, { type: "command" }>,
  runtime: PythonRuntime | undefined = resolvePythonRuntime(),
): string[] {
  const source = operation.portableCommand ?? operation.command;
  if (source[0] === "<python>") {
    return runtime ? [...runtime.command, ...source.slice(1)] : source;
  }
  return runtime ? withPythonRuntime(source, runtime) : source;
}

function commandMatches(
  operation: Extract<ReplayOperation, { type: "command" }>,
  exitCode: number,
  stdout: string,
  stderr: string,
  timedOut: boolean,
): boolean {
  return (operation.expectedTimeout === true ? timedOut : !timedOut) &&
    (operation.expectedExitCode === undefined || operation.expectedExitCode === exitCode) &&
    (operation.expectedStdout === undefined || operation.expectedStdout === stdout.replace(/\r\n/g, "\n")) &&
    (operation.expectedStderr === undefined || operation.expectedStderr === stderr.replace(/\r\n/g, "\n"));
}

function runCommand(operation: Extract<ReplayOperation, { type: "command" }>, root: string): ReplayCommandResult {
  try {
    const command = materializeReplayCommand(operation)
      .map((argument) => argument.replaceAll("<workspace>", "."));
    if (command[0] === "<python>") {
      return { command, exitCode: 127, stdout: "", stderr: "Python 3 is unavailable.", timedOut: false, matchesExpected: false };
    }
    if (command[0] === "<shell>") {
      const fallback = operation.command.map((argument) => argument.replaceAll("<workspace>", "."));
      return runCommand({ ...operation, portableCommand: undefined, command: fallback }, root);
    }
    const executable = command[0] ?? "";
    const result = spawnSync(executable, command.slice(1), {
      cwd: inside(root, operation.cwd ?? "."),
      env: { ...process.env, ...operation.env },
      input: operation.stdin,
      encoding: "utf8",
      shell: false,
      timeout: operation.timeoutMs,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.error ? `${result.stderr ?? ""}${result.error.message}` : result.stderr ?? "";
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const exitCode = result.status ?? (timedOut ? 124 : 127);
    return { command, exitCode, stdout, stderr, timedOut, matchesExpected: commandMatches(operation, exitCode, stdout, stderr, timedOut) };
  } catch (error) {
    return { command: operation.command, exitCode: 127, stdout: "", stderr: (error as Error).message, timedOut: false, matchesExpected: false };
  }
}

async function runCommandAsync(
  operation: Extract<ReplayOperation, { type: "command" }>,
  root: string,
): Promise<ReplayCommandResult> {
  const source = operation.portableCommand ?? operation.command;
  if (source[0] !== "<shell>") return runCommand(operation, root);
  const runtime = resolvePythonRuntime();
  if (source[1]?.includes("<python>") && !runtime) {
    return { command: source, exitCode: 127, stdout: "", stderr: "Python 3 is unavailable.", timedOut: false, matchesExpected: false };
  }
  const python = runtime?.command.map((part) => $.escape(part)).join(" ") ?? "<python>";
  const script = (source[1] ?? "").replaceAll("<python>", python).replaceAll("<workspace>", ".");
  try {
    const task = $`${{ raw: script }}`
      .cwd(inside(root, operation.cwd ?? "."))
      .env({ ...process.env, ...operation.env })
      .quiet()
      .nothrow();
    if (operation.stdin) {
      const writer = task.stdin.getWriter();
      await writer.write(new TextEncoder().encode(operation.stdin));
      await writer.close();
    }
    const result = await task;
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    return {
      command: ["<shell>", script],
      exitCode: result.exitCode,
      stdout,
      stderr,
      timedOut: false,
      matchesExpected: commandMatches(operation, result.exitCode, stdout, stderr, false),
    };
  } catch (error) {
    return { command: ["<shell>", script], exitCode: 127, stdout: "", stderr: (error as Error).message, timedOut: false, matchesExpected: false };
  }
}

function operationText(result: ReplayCommandResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return `$ ${result.command.join(" ")}\n${output}`.trim();
}

export async function executeReplayAsync(replay: Replay, root = process.cwd()): Promise<ReplayExecution> {
  const files: string[] = [];
  const commands: ReplayCommandResult[] = [];
  let ok = true;
  for (const operation of replay.operations) {
    const result = await executeReplayOperationAsync(operation, root);
    files.push(...result.files);
    if (result.command) commands.push(result.command);
    if (!result.ok) ok = false;
  }
  const parts = [...(replay.commentary ?? []), ...commands.map(operationText)].filter(Boolean);
  return { files, commands, ok, text: parts.join("\n\n") };
}

export function executeReplay(replay: Replay, root = process.cwd()): ReplayExecution {
  const files: string[] = [];
  const commands: ReplayCommandResult[] = [];
  let ok = true;
  for (const operation of replay.operations) {
    const result = executeReplayOperation(operation, root);
    files.push(...result.files);
    if (result.command) commands.push(result.command);
    if (!result.ok) ok = false;
  }
  const parts = [
    ...(replay.commentary ?? []),
    ...commands.map(operationText),
  ].filter(Boolean);
  return { files, commands, ok, text: parts.join("\n\n") };
}

/** Execute one trusted replay operation for the built-in learner. */
export function executeReplayOperation(
  operation: ReplayOperation,
  root = process.cwd(),
): ReplayOperationExecution {
  if (operation.type === "write") {
    const path = inside(root, operation.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, operation.content);
    return { files: [path], ok: true, text: `Wrote ${operation.path}` };
  }
  if (operation.type === "edit") {
    applyEdit(operation, root);
    return { files: [inside(root, operation.path)], ok: true, text: `Updated ${operation.path}` };
  }
  if (operation.type === "read") {
    const text = readFileSync(inside(root, operation.path), "utf8");
    return { files: [], ok: true, text };
  }

  const command = runCommand(operation, root);
  const output = [command.stdout, command.stderr].filter(Boolean).join("\n").trim();
  const text = [
    `$ ${command.command.join(" ")}`,
    output,
    `exit code ${command.exitCode}`,
  ].filter(Boolean).join("\n");
  return {
    files: [],
    command,
    ok: command.exitCode === (operation.expectedExitCode ?? 0) && command.matchesExpected,
    text,
  };
}

export async function executeReplayOperationAsync(
  operation: ReplayOperation,
  root = process.cwd(),
): Promise<ReplayOperationExecution> {
  if (operation.type !== "command") return executeReplayOperation(operation, root);
  const command = await runCommandAsync(operation, root);
  const output = [command.stdout, command.stderr].filter(Boolean).join("\n").trim();
  const text = [
    `$ ${operation.display?.command ?? command.command.join(" ")}`,
    output,
    command.timedOut ? "timed out as expected" : `exit code ${command.exitCode}`,
  ].filter(Boolean).join("\n");
  return { files: [], command, ok: command.matchesExpected, text };
}
