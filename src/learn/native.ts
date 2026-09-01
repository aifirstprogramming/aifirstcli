import { mkdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { Args } from "../cli";
import { boolFlag } from "../cli";
import { resolveScope } from "../books";
import { ALL_BOOKS, setBook, setWorkspace, workspaceFor } from "../config";
import { resolveContent } from "../content";
import type { Content, ReplayStep } from "../content/types";
import {
  checkDependencies,
  dependencyNames,
  installDependencies,
  installPythonRuntime,
  pythonRuntimeInstallPlan,
  resolvePythonRuntime,
} from "../dependencies";
import { finalResponse, resume } from "../exercises";
import { read as readLog } from "../log/progress";
import { bold, cyan, dim, glyph, green, out, red } from "../output";
import { home } from "../paths";
import { choose, confirm, isInteractive } from "../prompt";
import { executeReplayOperation } from "../replay/executor";
import type { NativeLearnAction } from "./actions";
import {
  respond,
  type DependencySession,
  type Reply,
  type RequestMessage,
  type ToolDefinition,
} from "../bookmode/responder";
import type { PlanningSession } from "../bookmode/planning";
import { learnTextRate } from "./pacing";
import { renderTerminalMarkdown, type TerminalRenderOptions } from "./terminalRenderer";

const TOOLS: ToolDefinition[] = [
  { name: "Bash", input_schema: { properties: { command: { type: "string" } } } },
  { name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } } } },
  { name: "Edit", input_schema: { properties: { file_path: { type: "string" } } } },
  { name: "Read", input_schema: { properties: { file_path: { type: "string" } } } },
  { name: "AskUserQuestion", input_schema: { properties: { questions: { type: "array" } } } },
];

interface ConfirmationSession {
  stepId?: string;
  stepIds?: string[];
  confirmationToolId?: string;
  ambiguityToolId?: string;
}

interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
}

export async function nativeLearn(args: Args): Promise<void> {
  if (!isInteractive()) {
    out("The built-in learner needs an interactive terminal.");
    out(dim("Run aifirst learn in a terminal, or use explicit commands with --format json."));
    process.exitCode = 1;
    return;
  }

  const { content } = resolveContent();
  const selection = await ensureBook(content);
  if (!selection) return;

  const workspace = ensureWorkspace(selection.key);
  process.chdir(workspace);

  out();
  out(`  ${bold("AI First learner")}`);
  out(`  ${green(glyph.done)} ${dim("built in, no AI account or model required")}`);
  out(`  ${dim(`workspace: ${workspace}`)}`);

  const confirmation: ConfirmationSession = {};
  const planning: PlanningSession = { answers: {} };
  const dependencies: DependencySession = {};
  let reviewStep: ReplayStep | undefined;
  const renderOptions: TerminalRenderOptions = {
    charsPerSecond: learnTextRate(),
    noAnimation: boolFlag(args, "no-animation"),
  };

  while (true) {
    const scope = resolveScope(content);
    const picked = resume(content, readLog(), scope);
    const example = picked.example;
    if (!example) {
      out();
      out(`  ${green("Congratulations!")} ${bold("You have completed every available exercise.")}`);
      out();
      return;
    }
    const step = reviewStep ?? (finalResponse(example) as ReplayStep);
    const activeExample = content.examples.find((candidate) => candidate.id === step.exampleId) ?? example;
    reviewStep = undefined;

    const action = await choose("What would you like to do?", [
      { key: "continue", label: `Continue with ${step.id}: ${activeExample.title}` },
      { key: "read", label: "Read it without changing files" },
      { key: "exit", label: "Exit learning" },
    ]);
    if (!action || action === "exit") return;

    if (action === "read") {
      const reply = respond(
        { messages: [{ role: "user", content: `aifirst show ${step.id}` }], tools: TOOLS },
        content,
        readLog(),
        { language: selection.language, confirmation, planning, dependencies },
      );
      await renderReply(reply, renderOptions);
      continue;
    }

    await driveExercise(step.prompt, content, selection.language, confirmation, planning, dependencies, renderOptions);

    const completed = readLog().exercises[activeExample.id]?.status === "done";
    const next = await choose(completed ? "Lesson complete" : "Lesson paused", [
      { key: "continue", label: completed ? "Continue to the next exercise" : "Try this exercise again" },
      { key: "review", label: "Review this exercise" },
      { key: "exit", label: "Exit learning" },
    ]);
    if (!next || next === "exit") return;
    if (next === "review") reviewStep = step;
  }
}

async function ensureBook(content: Content): Promise<{ key: string; language?: string } | undefined> {
  const current = resolveScope(content);
  if (current.kind === "book") return { key: current.book.tag, language: current.book.language };
  if (current.kind === "all") return { key: ALL_BOOKS };

  const picked = await choose("Which book are you reading?", [
    ...content.books.map((book) => ({ key: book.tag, label: book.title })),
    { key: ALL_BOOKS, label: "All books" },
  ]);
  if (!picked) return undefined;
  if (picked === ALL_BOOKS) {
    setBook(ALL_BOOKS);
    return { key: ALL_BOOKS };
  }
  const book = content.books.find((candidate) => candidate.tag === picked)!;
  setBook(book.id);
  return { key: book.tag, language: book.language };
}

function ensureWorkspace(key: string): string {
  const saved = workspaceFor(key);
  const workspace = resolve(saved ?? join(home(), "aifirst", key));
  mkdirSync(workspace, { recursive: true });
  if (!saved) setWorkspace(key, workspace);
  return workspace;
}

async function driveExercise(
  prompt: string,
  content: Content,
  language: string | undefined,
  confirmation: ConfirmationSession,
  planning: PlanningSession,
  dependencies: DependencySession,
  renderOptions: TerminalRenderOptions,
): Promise<void> {
  const messages: RequestMessage[] = [{ role: "user", content: prompt }];
  const shownCode = new Set<string>();

  for (let turn = 0; turn < 200; turn++) {
    const reply = respond(
      { messages, tools: TOOLS },
      content,
      readLog(),
      { language, confirmation, planning, dependencies },
    );
    await renderReply(reply, renderOptions);
    if (!reply.toolUse) return;

    const id = reply.toolUse.id ?? `aifirst_native_${crypto.randomUUID()}`;
    messages.push({
      role: "assistant",
      content: [
        ...(reply.text ? [{ type: "text", text: reply.text }] : []),
        { type: "tool_use", id, name: reply.toolUse.name, input: reply.toolUse.input },
      ],
    });
    await renderActionCodeBefore(reply.toolUse.nativeAction, content, renderOptions, shownCode);
    const result = await executeTool(reply.toolUse.nativeAction, reply.toolUse.input);
    await renderActionCodeAfter(reply.toolUse.nativeAction, result.files, renderOptions);
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: id,
        content: result.content,
        ...(result.failed ? { is_error: true } : {}),
      }],
    });
  }

  throw new Error("The built-in learner exceeded its safe turn limit.");
}

async function renderReply(reply: Reply, options: TerminalRenderOptions): Promise<void> {
  if (!reply.text.trim()) return;
  process.stdout.write("\n");
  await renderTerminalMarkdown(reply.text, options);
  process.stdout.write("\n");
}

async function executeTool(
  action: NativeLearnAction | undefined,
  input: Record<string, unknown>,
): Promise<{ failed: boolean; content: string; files?: string[] }> {
  if (!action) return answerQuestions(input);

  try {
    if (action.kind === "replay-operation") {
      const operation = selfReplayOperation(action.operation);
      const result = executeReplayOperation(operation, process.cwd());
      out(`  ${result.ok ? green(glyph.done) : red(glyph.todo)} ${result.text.split("\n")[0]}`);
      return {
        failed: action.operation.type === "command" && (result.command?.exitCode ?? 1) !== 0,
        content: summarizeReplayResult(action.operation, result.text, result.command?.stdout),
        files: result.files,
      };
    }

    if (action.kind === "install-dependencies") {
      const { content } = resolveContent();
      const step = content.steps.find((candidate) => candidate.id === action.stepId);
      if (!step) return { failed: true, content: `Unknown exercise ${action.stepId}` };
      const installed = await installDependencies(step.dependencies);
      if (installed.ok) out(`  ${green(glyph.done)} installed ${dependencyNames(step.dependencies)}`);
      return { failed: !installed.ok, content: JSON.stringify({ ok: installed.ok, output: installed.output }) };
    }

    return runExercise(action.stepId);
  } catch (error) {
    return { failed: true, content: (error as Error).message };
  }
}

function selfReplayOperation(
  operation: Extract<NativeLearnAction, { kind: "replay-operation" }>["operation"],
): Extract<NativeLearnAction, { kind: "replay-operation" }>["operation"] {
  if (operation.type !== "command" || !aifirstRunId(operation.command)) return operation;
  return { ...operation, command: selfCommand(operation.command.slice(1)) };
}

async function renderActionCodeBefore(
  action: NativeLearnAction | undefined,
  content: Content,
  options: TerminalRenderOptions,
  shown: Set<string>,
): Promise<void> {
  if (action?.kind !== "replay-operation") return;
  const operation = action.operation;
  if (operation.type === "command") {
    const id = aifirstRunId(operation.command);
    if (!id || shown.has(`step:${id}`)) return;
    const step = content.steps.find((candidate) => candidate.id === id);
    if (!step) return;
    shown.add(`step:${id}`);
    await renderCode(step.response, step.language, options);
    return;
  }
  if (operation.type === "write" && !shown.has(`write:${operation.path}`)) {
    shown.add(`write:${operation.path}`);
    await renderCode(operation.content, languageForPath(operation.path), options, operation.path);
  }
}

async function renderActionCodeAfter(
  action: NativeLearnAction | undefined,
  files: string[] | undefined,
  options: TerminalRenderOptions,
): Promise<void> {
  if (action?.kind !== "replay-operation" || action.operation.type !== "edit") return;
  const file = files?.[0];
  if (!file) return;
  try {
    await renderCode(readFileSync(file, "utf8"), languageForPath(file), options, action.operation.path);
  } catch {
    // The replay result already reports a failed edit/read; rendering is optional.
  }
}

async function renderCode(
  code: string,
  language: string,
  options: TerminalRenderOptions,
  path?: string,
): Promise<void> {
  const fence = code.includes("```") ? "````" : "```";
  const title = path ? `## Code - \`${path}\`` : "## Code";
  process.stdout.write("\n");
  await renderTerminalMarkdown(`${title}\n\n${fence}${language}\n${code.replace(/\n+$/, "")}\n${fence}`, options);
  process.stdout.write("\n");
}

function aifirstRunId(command: string[]): string | undefined {
  const executable = command[0]?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "");
  if (executable !== "aifirst" || command[1] !== "run") return undefined;
  return command[2];
}

function languageForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".py": return "python";
    case ".java": return "java";
    case ".json": return "json";
    case ".sh": case ".bash": return "bash";
    case ".xml": case ".html": return "xml";
    case ".diff": case ".patch": return "diff";
    default: return "text";
  }
}

function summarizeReplayResult(
  operation: Extract<NativeLearnAction, { kind: "replay-operation" }>["operation"],
  fallback: string,
  stdout: string | undefined,
): string {
  if (operation.type !== "command" || !aifirstRunId(operation.command) || !stdout) return fallback;
  try {
    const result = JSON.parse(stdout) as {
      ran?: { exitCode?: number; stdout?: string; stderr?: string };
    };
    const output = `${result.ran?.stdout ?? ""}${result.ran?.stderr ?? ""}`.replace(/\n+$/, "");
    const exitCode = result.ran?.exitCode ?? 0;
    return [
      ...(output ? ["## Output", "", "```text", output, "```", ""] : []),
      `Exit code ${exitCode}.`,
    ].join("\n");
  } catch {
    return fallback;
  }
}

async function answerQuestions(input: Record<string, unknown>): Promise<{ failed: boolean; content: string }> {
  const questions = Array.isArray(input.questions) ? input.questions as Question[] : [];
  if (questions.length === 0) return { failed: true, content: "No supported native action was provided." };
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const choices = question.options.map((option, index) => ({
      key: String(index + 1),
      label: option.description ? `${option.label} ${dim(`- ${option.description}`)}` : option.label,
    }));
    const picked = await choose(question.question, choices);
    if (!picked) return { failed: true, content: "(no content)" };
    answers[question.question] = question.options[Number(picked) - 1].label;
  }
  return { failed: false, content: JSON.stringify({ answers }) };
}

async function runExercise(stepId: string): Promise<{ failed: boolean; content: string }> {
  const { content } = resolveContent();
  const step = content.steps.find((candidate) => candidate.id === stepId);
  if (!step) return { failed: true, content: `Unknown exercise ${stepId}` };

  let runtime = resolvePythonRuntime();
  if (step.language === "python" && !runtime) {
    const plan = pythonRuntimeInstallPlan();
    if (!plan) {
      return { failed: true, content: "Python 3 is not installed and no supported package manager was found." };
    }
    const accepted = await confirm(
      `Install Python 3 with ${plan.label}?`,
      "No runtime will be installed unless you approve.",
    );
    if (!accepted) return { failed: true, content: "Python installation was cancelled." };
    const installed = await installPythonRuntime(plan);
    if (!installed.ok || !installed.runtime) {
      return { failed: true, content: installed.output || "Python installation failed." };
    }
    runtime = installed.runtime;
    out(`  ${green(glyph.done)} installed Python 3 with ${plan.label}`);
  }

  const report = checkDependencies(step.dependencies, runtime);
  if (report.missing.length > 0) {
    if (!report.runtime) return { failed: true, content: report.error ?? "Python 3 is unavailable." };
    const accepted = await confirm(
      `Install ${dependencyNames(report.missing)} now?`,
      "You can return Home without changing files.",
    );
    if (!accepted) return { failed: true, content: "Dependency installation was cancelled." };
    const installed = await installDependencies(step.dependencies, report.runtime);
    if (!installed.ok) return { failed: true, content: installed.output };
  }

  const argv = selfCommand(["run", stepId, "--yes", "--format", "json"]);
  const proc = Bun.spawn(argv, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", stdin: "inherit" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const detail = `${stdout}${stderr}`.trim();
  if (proc.exitCode === 0) {
    try {
      const result = JSON.parse(stdout) as { ran?: { stdout?: string; stderr?: string }; path?: string };
      if (result.path) out(`  ${green(glyph.done)} wrote ${result.path}`);
      const programOutput = `${result.ran?.stdout ?? ""}${result.ran?.stderr ?? ""}`.trim();
      if (programOutput) {
        out();
        out(`  ${cyan("Output")}`);
        for (const line of programOutput.split("\n")) out(`  ${line}`);
      }
    } catch {
      // The responder still receives the raw result if a future JSON shape changes.
    }
  }
  return { failed: proc.exitCode !== 0, content: detail || `exit code ${proc.exitCode ?? 1}` };
}

function selfCommand(args: string[]): string[] {
  const entry = process.argv[1];
  if (entry && /\.(?:ts|js|mjs|cjs)$/.test(entry)) return [process.execPath, "run", entry, ...args];
  return [process.execPath, ...args];
}
