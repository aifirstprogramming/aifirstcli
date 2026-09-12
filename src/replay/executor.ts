import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

export interface ReplayFileGuard {
  decide(operation: Extract<ReplayOperation, { type: "write" | "edit" }>, root: string):
    | { kind: "execute" }
    | { kind: "replace"; path: string; content: string }
    | { kind: "already-applied"; path: string }
    | { kind: "reject"; path: string };
  record(path: string): void;
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
  relaxOutput = false,
): boolean {
  return (operation.expectedTimeout === true ? timedOut : !timedOut) &&
    (operation.expectedExitCode === undefined || operation.expectedExitCode === exitCode) &&
    (relaxOutput || operation.expectedStdout === undefined || operation.expectedStdout === stdout.replace(/\r\n/g, "\n")) &&
    (relaxOutput || operation.expectedStderr === undefined || operation.expectedStderr === stderr.replace(/\r\n/g, "\n"));
}

function runCommand(
  operation: Extract<ReplayOperation, { type: "command" }>,
  root: string,
  relaxOutput = false,
): ReplayCommandResult {
  try {
    const command = materializeReplayCommand(operation)
      .map((argument) => argument.replaceAll("<workspace>", "."));
    if (operation.graphical && process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return {
        command,
        exitCode: 0,
        stdout: "Skipped graphical launch because no display is available.\n",
        stderr: "",
        timedOut: false,
        matchesExpected: true,
      };
    }
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
    return { command, exitCode, stdout, stderr, timedOut, matchesExpected: commandMatches(operation, exitCode, stdout, stderr, timedOut, relaxOutput) };
  } catch (error) {
    return { command: operation.command, exitCode: 127, stdout: "", stderr: (error as Error).message, timedOut: false, matchesExpected: false };
  }
}

async function runCommandAsync(
  operation: Extract<ReplayOperation, { type: "command" }>,
  root: string,
  relaxOutput = false,
): Promise<ReplayCommandResult> {
  const source = operation.portableCommand ?? operation.command;
  if (source[0] !== "<shell>") return runCommand(operation, root, relaxOutput);
  const runtime = resolvePythonRuntime();
  if (source[1]?.includes("<python>") && !runtime) {
    return { command: source, exitCode: 127, stdout: "", stderr: "Python 3 is unavailable.", timedOut: false, matchesExpected: false };
  }
  const python = runtime?.command.map((part) => $.escape(part)).join(" ") ?? "<python>";
  const script = (source[1] ?? "").replaceAll("<python>", python).replaceAll("<workspace>", ".");
  const removeArgument = simpleRemoveArgument(script);
  if (removeArgument) {
    try {
      unlinkSync(inside(root, removeArgument));
      return {
        command: ["<shell>", script],
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        matchesExpected: commandMatches(operation, 0, "", "", false, relaxOutput),
      };
    } catch (error) {
      return { command: ["<shell>", script], exitCode: 1, stdout: "", stderr: (error as Error).message, timedOut: false, matchesExpected: false };
    }
  }
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
      matchesExpected: commandMatches(operation, result.exitCode, stdout, stderr, false, relaxOutput),
    };
  } catch (error) {
    return { command: ["<shell>", script], exitCode: 127, stdout: "", stderr: (error as Error).message, timedOut: false, matchesExpected: false };
  }
}

function simpleRemoveArgument(script: string): string | undefined {
  const match = script.trim().match(/^rm\s+(?:"([^"]+)"|'([^']+)'|([^\s'"\\]+))\s*$/);
  const argument = (match?.[1] ?? match?.[2] ?? match?.[3])?.replaceAll("\\", "/");
  if (!argument || /[;&|`$]/.test(argument)) return undefined;
  return argument;
}

function operationText(result: ReplayCommandResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return `$ ${result.command.join(" ")}\n${output}`.trim();
}

export async function executeReplayAsync(
  replay: Replay,
  root = process.cwd(),
  guard?: ReplayFileGuard,
  options: { relaxOutput?: boolean } = {},
): Promise<ReplayExecution> {
  const files: string[] = [];
  const commands: ReplayCommandResult[] = [];
  const notices: string[] = [];
  let ok = true;
  for (const operation of replay.operations) {
    let executable = operation;
    if (guard && (operation.type === "write" || operation.type === "edit")) {
      const decision = guard.decide(operation, root);
      if (decision.kind === "reject") {
        notices.push(`${decision.path} already exists with different contents, so the replay left it alone.`);
        ok = false;
        break;
      }
      if (decision.kind === "already-applied") {
        guard.record(decision.path);
        files.push(decision.path);
        continue;
      }
      if (decision.kind === "replace") {
        executable = { type: "write", path: operation.path, content: decision.content };
      }
    }
    const result = await executeReplayOperationAsync(executable, root, options);
    files.push(...result.files);
    if (result.command) commands.push(result.command);
    if (!result.ok) {
      ok = false;
      break;
    }
    if (guard && result.ok && (operation.type === "write" || operation.type === "edit")) {
      guard.record(result.files[0]!);
    }
  }
  const parts = [...(replay.commentary ?? []), ...notices, ...commands.map(operationText)].filter(Boolean);
  return { files, commands, ok, text: parts.join("\n\n") };
}

export function executeReplay(replay: Replay, root = process.cwd(), guard?: ReplayFileGuard): ReplayExecution {
  const files: string[] = [];
  const commands: ReplayCommandResult[] = [];
  const notices: string[] = [];
  let ok = true;
  for (const operation of replay.operations) {
    let executable = operation;
    if (guard && (operation.type === "write" || operation.type === "edit")) {
      const decision = guard.decide(operation, root);
      if (decision.kind === "reject") {
        notices.push(`${decision.path} already exists with different contents, so the replay left it alone.`);
        ok = false;
        break;
      }
      if (decision.kind === "already-applied") {
        guard.record(decision.path);
        files.push(decision.path);
        continue;
      }
      if (decision.kind === "replace") {
        executable = { type: "write", path: operation.path, content: decision.content };
      }
    }
    const result = executeReplayOperation(executable, root);
    files.push(...result.files);
    if (result.command) commands.push(result.command);
    if (!result.ok) {
      ok = false;
      break;
    }
    if (guard && result.ok && (operation.type === "write" || operation.type === "edit")) {
      guard.record(result.files[0]!);
    }
  }
  const parts = [
    ...(replay.commentary ?? []),
    ...notices,
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
  options: { relaxOutput?: boolean } = {},
): Promise<ReplayOperationExecution> {
  if (operation.type !== "command") return executeReplayOperation(operation, root);
  const command = await runCommandAsync(operation, root, options.relaxOutput);
  const output = [command.stdout, command.stderr].filter(Boolean).join("\n").trim();
  const text = [
    `$ ${operation.display?.command ?? command.command.join(" ")}`,
    output,
    command.timedOut ? "timed out as expected" : `exit code ${command.exitCode}`,
  ].filter(Boolean).join("\n");
  return { files: [], command, ok: command.matchesExpected, text };
}
