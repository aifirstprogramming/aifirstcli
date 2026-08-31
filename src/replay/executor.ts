import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Replay, ReplayOperation } from "../content/types";

export interface ReplayCommandResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  matchesExpected: boolean;
}

export interface ReplayExecution {
  files: string[];
  commands: ReplayCommandResult[];
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

function runCommand(operation: Extract<ReplayOperation, { type: "command" }>, root: string): ReplayCommandResult {
  try {
    const executable = process.platform === "win32" && operation.command[0] === "python3"
      ? "python"
      : operation.command[0] ?? "";
    const result = spawnSync(executable, operation.command.slice(1), {
      cwd: inside(root, operation.cwd ?? "."),
      env: { ...process.env, ...operation.env },
      input: operation.stdin,
      encoding: "utf8",
      shell: false,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.error ? `${result.stderr ?? ""}${result.error.message}` : result.stderr ?? "";
    const comparableStdout = stdout.replace(/\r\n/g, "\n");
    const comparableStderr = stderr.replace(/\r\n/g, "\n");
    const exitCode = result.status ?? 127;
    const matchesExpected =
      (operation.expectedExitCode === undefined || operation.expectedExitCode === exitCode) &&
      (operation.expectedStdout === undefined || operation.expectedStdout === comparableStdout) &&
      (operation.expectedStderr === undefined || operation.expectedStderr === comparableStderr);
    return { command: operation.command, exitCode, stdout, stderr, matchesExpected };
  } catch (error) {
    return { command: operation.command, exitCode: 127, stdout: "", stderr: (error as Error).message, matchesExpected: false };
  }
}

function operationText(result: ReplayCommandResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return `$ ${result.command.join(" ")}\n${output}`.trim();
}

export function executeReplay(replay: Replay, root = process.cwd()): ReplayExecution {
  const files: string[] = [];
  const commands: ReplayCommandResult[] = [];
  let ok = true;
  for (const operation of replay.operations) {
    if (operation.type === "write") {
      const path = inside(root, operation.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, operation.content);
      files.push(path);
      continue;
    }
    if (operation.type === "edit") {
      applyEdit(operation, root);
      files.push(inside(root, operation.path));
      continue;
    }
    if (operation.type === "read") {
      readFileSync(inside(root, operation.path));
      continue;
    }
    const result = runCommand(operation, root);
    commands.push(result);
    if (result.exitCode !== (operation.expectedExitCode ?? 0) || !result.matchesExpected) ok = false;
  }
  const parts = [
    ...(replay.commentary ?? []),
    ...commands.map(operationText),
  ].filter(Boolean);
  return { files, commands, ok, text: parts.join("\n\n") };
}
