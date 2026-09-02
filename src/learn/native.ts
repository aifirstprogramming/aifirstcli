import { extname } from "node:path";
import { exercisePath } from "@aifirst/content";
import type { Args } from "../cli";
import { boolFlag } from "../cli";
import { resolveScope, type Scope } from "../books";
import { ALL_BOOKS, setBook } from "../config";
import { resolveContent } from "../content";
import { declaredDependencies, type Content, type Example, type ReplayOperation, type ReplayStep } from "../content/types";
import {
  checkDependencies,
  dependencyNames,
  installDependencies,
  installPythonRuntime,
  pythonRuntimeInstallPlan,
  resolvePythonRuntime,
} from "../dependencies";
import { finalResponse, report, resume } from "../exercises";
import { mark, read as readLog, setPosition } from "../log/progress";
import { bar, bold, cyan, dim, glyph, green, out, red, yellow } from "../output";
import { choose, chooseOrInput, confirm, consumePromptInterrupt, isInteractive } from "../prompt";
import { executeReplayOperation, type ReplayOperationExecution } from "../replay/executor";
import type { NativeLearnAction } from "./actions";
import {
  respond,
  type DependencySession,
  type Reply,
  type RequestMessage,
  type ToolDefinition,
} from "../bookmode/responder";
import type { PlanningSession } from "../bookmode/planning";
import { chapterLabel, exerciseLabel, learnChapters, lookupExercise } from "./menu";
import { learnTextRate } from "./pacing";
import { renderTerminalMarkdown, type TerminalRenderOptions } from "./terminalRenderer";
import { unifiedPatch } from "../textdiff";
import { currentTuiSession } from "../tui/session";
import { runWithTui, shouldUseTui } from "../tui";
import { prepareExerciseFiles } from "../commands/run";
import { ReplayStateGuard } from "./replayState";
import { ensureWorkspace as resolveWorkspace } from "../workspace";

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

interface BookSelection {
  key: string;
  title: string;
}

interface ExerciseDriveResult {
  failed: boolean;
  readyToRun: boolean;
  preparedInto?: string;
}

interface ToolExecutionResult {
  failed: boolean;
  content: string;
  files?: string[];
  prepared?: boolean;
  preparedInto?: string;
}

type PostLessonAction = "next" | "retry" | "menu" | "exit";

export async function nativeLearn(args: Args): Promise<void> {
  if (shouldUseTui(args) && !currentTuiSession()) {
    return runWithTui(args, () => nativeLearn(args), "AI First Learn");
  }
  if (!isInteractive()) {
    out("The built-in learner needs an interactive terminal.");
    out(dim("Run aifirst learn in a terminal, or use explicit commands with --format json."));
    process.exitCode = 1;
    return;
  }

  const { content } = resolveContent();
  let selection = await ensureBook(content);
  if (!selection) return;

  let workspace = resolveWorkspace(content, selection.key).path;
  process.chdir(workspace);
  updateTuiWorkspace(selection, workspace);

  out();
  out(`  ${bold("AI First learner")}`);
  out(`  ${green(glyph.done)} ${dim("built in, no AI account or model required")}`);
  let confirmation: ConfirmationSession = {};
  let planning: PlanningSession = { answers: {}, questionMode: "sequential" };
  let dependencies: DependencySession = {};
  let queuedExample: Example | undefined;
  const activateSelection = (next: BookSelection): void => {
    selection = next;
    if (next.key === ALL_BOOKS) setBook(ALL_BOOKS);
    else setBook(content.books.find((book) => book.tag === next.key)!.id);
    workspace = resolveWorkspace(content, next.key).path;
    process.chdir(workspace);
    updateTuiWorkspace(next, workspace);
    confirmation = {};
    planning = { answers: {}, questionMode: "sequential" };
    dependencies = {};
  };
  const renderOptions: TerminalRenderOptions = {
    charsPerSecond: learnTextRate(),
    noAnimation: boolFlag(args, "no-animation"),
  };

  while (true) {
    const scope = resolveScope(content);
    let example = queuedExample;
    queuedExample = undefined;

    if (!example) {
      const nextExample = renderDashboard(content, scope, selection, workspace);
      const choices = [
        ...(nextExample ? [{ key: "continue", label: `Continue with ${nextExample.id}: ${nextExample.title}` }] : []),
        { key: "browse", label: "Browse chapters and run an exercise" },
        { key: "read", label: "Read an exercise without running it" },
        { key: "progress", label: "View progress" },
        { key: "book", label: "Change book" },
        { key: "exit", label: "Exit learning" },
      ];
      const action = await chooseOrInput(
        "What would you like to do?",
        choices,
        "Choose a number, or type an exercise ID, 2.6, title, or prompt words.",
      );
      if (!action) {
        if (consumePromptInterrupt()) return;
        continue;
      }
      if (action.kind === "input") {
        const requestedBook = selectionFromInput(action.value, content);
        if (requestedBook) {
          activateSelection(requestedBook);
          continue;
        }
        example = await chooseLookupResult(action.value, content, scope, readLog());
        if (!example) continue;
      } else if (action.key === "exit") {
        return;
      } else if (action.key === "continue") {
        example = nextExample ?? undefined;
      } else if (action.key === "browse" || action.key === "progress") {
        example = await browseExercise(content, scope, action.key === "progress");
        if (!example) continue;
      } else if (action.key === "read") {
        const toRead = await browseExercise(content, scope, false, "Choose an exercise to read");
        if (!toRead) continue;
        const owner = selectionForExample(toRead, content);
        if (owner.key !== selection.key) activateSelection(owner);
        setPosition(toRead.id);
        await readExercise(toRead, content, confirmation, planning, dependencies, renderOptions);
        continue;
      } else if (action.key === "book") {
        const changed = await chooseBook(content, "Choose a book");
        if (!changed) continue;
        activateSelection(changed);
        continue;
      }
    }

    if (!example) continue;
    const owner = selectionForExample(example, content);
    if (owner.key !== selection.key) activateSelection(owner);
    setPosition(example.id);
    const step = finalResponse(example) as ReplayStep;
    await renderExerciseIntroduction(example, step, renderOptions);
    const result = await driveExercise(
      step.prompt,
      content,
      example.language,
      confirmation,
      planning,
      dependencies,
      renderOptions,
      step,
    );
    if (result.readyToRun) {
      const completion = await runOrFinishExercise(
        example,
        step,
        content,
        confirmation,
        planning,
        dependencies,
        renderOptions,
        result.preparedInto,
      );
      if (completion === "exit") return;
      if (completion === "menu") continue;
      if (completion === "retry") {
        queuedExample = example;
        continue;
      }
    }
    const post = await postLessonMenu(
      example,
      step,
      result,
      content,
      confirmation,
      planning,
      dependencies,
      renderOptions,
    );
    if (post === "exit") return;
    if (post === "retry") queuedExample = example;
    if (post === "next") queuedExample = resume(content, readLog(), resolveScope(content)).example ?? undefined;
  }
}

function updateTuiWorkspace(selection: BookSelection, workspace: string): void {
  const tui = currentTuiSession();
  if (!tui) return;
  tui.setContext(`${selection.title} • ${workspace}`);
  tui.setPostExitMessage(`AI First workspace: ${workspace}`);
}

async function ensureBook(content: Content): Promise<BookSelection | undefined> {
  const current = resolveScope(content);
  if (current.kind === "book") {
    return selectionForBook(current.book);
  }
  if (current.kind === "all") return { key: ALL_BOOKS, title: "All books" };

  return chooseBook(content, "Which book are you reading?");
}

async function chooseBook(content: Content, question: string): Promise<BookSelection | undefined> {
  const picked = await choose(question, [
    ...content.books.map((book) => ({ key: book.tag, label: book.title })),
    { key: ALL_BOOKS, label: "All books" },
  ]);
  if (!picked) return undefined;
  if (picked === ALL_BOOKS) {
    setBook(ALL_BOOKS);
    return { key: ALL_BOOKS, title: "All books" };
  }
  const book = content.books.find((candidate) => candidate.tag === picked)!;
  setBook(book.id);
  return selectionForBook(book);
}

function selectionFromInput(input: string, content: Content): BookSelection | undefined {
  const normalized = input.trim().toLowerCase();
  if (normalized === ALL_BOOKS || normalized === "both") return { key: ALL_BOOKS, title: "All books" };
  const book = content.books.find((candidate) =>
    candidate.tag.toLowerCase() === normalized ||
    candidate.language.toLowerCase() === normalized ||
    candidate.title.toLowerCase() === normalized
  );
  return book ? selectionForBook(book) : undefined;
}

function selectionForExample(example: Example, content: Content): BookSelection {
  return selectionForBook(content.books.find((book) => book.id === example.bookId)!);
}

function selectionForBook(book: Content["books"][number]): BookSelection {
  return { key: book.tag, title: book.title };
}

function renderDashboard(
  content: Content,
  scope: Scope,
  selection: BookSelection,
  workspace: string,
): Example | null {
  const log = readLog();
  const progress = report(content, log, scope);
  const next = resume(content, log, scope).example;

  out();
  out(`  ${bold(selection.title)}`);
  out(`  ${bar(progress.overall.fraction, 16)} ${bold(`${Math.round(progress.overall.fraction * 100)}%`)} ${dim(
    `${progress.overall.done}/${progress.overall.total} done, ${progress.overall.skipped} skipped`,
  )}`);
  out(`  ${dim(`workspace: ${workspace}`)}`);

  if (next) {
    const book = progress.books.find((candidate) => candidate.bookId === next.bookId);
    const chapter = book?.chapters.find((candidate) => candidate.number === next.chapterNumber);
    if (chapter) {
      out(`  ${dim(`${next.chapterTitle}: ${chapter.counts.done}/${chapter.counts.total} complete`)}`);
    }
    out(`  ${cyan(glyph.arrow)} next ${bold(next.id)}  ${next.title}`);
  } else {
    out(`  ${green(glyph.done)} ${bold("Every available exercise is handled.")}`);
    out(dim("  You can still browse, read, rerun exercises, or review progress."));
  }
  return next;
}

async function browseExercise(
  content: Content,
  scope: Scope,
  detailedProgress: boolean,
  question = "Choose a chapter",
): Promise<Example | undefined> {
  let browseScope = scope;
  if (scope.kind === "all") {
    const picked = await choose("Choose a book to browse", [
      ...content.books.map((book) => ({ key: book.tag, label: book.title })),
      { key: "back", label: "Back to the learning menu" },
    ]);
    if (!picked || picked === "back") return undefined;
    const book = content.books.find((candidate) => candidate.tag === picked);
    if (!book) return undefined;
    browseScope = { kind: "book", book };
  }

  while (true) {
    const log = readLog();
    const progress = report(content, log, browseScope);
    const bookProgress = progress.books[0];
    if (detailedProgress && bookProgress) renderProgressOverview(bookProgress.bookTitle, bookProgress.counts);

    const chapterChoices = learnChapters(content, log, browseScope).map((chapter) => ({
      key: String(chapter.view.number),
      label: chapterLabel(chapter),
    }));
    const picked = await chooseOrInput(
      question,
      [...chapterChoices, { key: "back", label: "Back to the learning menu" }],
      "Choose a chapter, or type an exercise ID, 2.6, title, or prompt words.",
    );
    if (!picked) {
      if (consumePromptInterrupt()) return undefined;
      continue;
    }
    if (picked.kind === "input") {
      const example = await chooseLookupResult(picked.value, content, browseScope, log);
      if (example) return example;
      continue;
    }
    if (picked.key === "back") return undefined;

    const chapter = learnChapters(content, log, browseScope)
      .find((candidate) => String(candidate.view.number) === picked.key);
    if (!chapter) continue;
    if (chapter.view.examples.length === 0) {
      out();
      out(`  ${bold(chapter.view.title)}`);
      if (chapter.view.goal) out(`  ${chapter.view.goal}`);
      out(dim("  No exercises are published for this chapter yet."));
      continue;
    }

    while (true) {
      const exerciseLog = readLog();
      const exerciseChoices = chapter.view.examples.map((example) => ({
        key: example.id,
        label: exerciseLabel(example, exerciseLog),
      }));
      const selected = await chooseOrInput(
        chapter.view.title,
        [...exerciseChoices, { key: "back", label: "Back to chapters" }],
        "Choose an exercise, or type an exercise ID, title, or prompt words.",
      );
      if (!selected) {
        if (consumePromptInterrupt()) return undefined;
        continue;
      }
      if (selected.kind === "input") {
        const example = await chooseLookupResult(selected.value, content, browseScope, exerciseLog);
        if (example) return example;
        continue;
      }
      if (selected.key === "back") break;
      const example = chapter.view.examples.find((candidate) => candidate.id === selected.key);
      if (example) return example;
    }
  }
}

async function chooseLookupResult(
  input: string,
  content: Content,
  scope: Scope,
  log: ReturnType<typeof readLog>,
): Promise<Example | undefined> {
  const result = lookupExercise(input, content, scope);
  if (result.kind === "exercise") return result.example;
  if (result.kind === "none") {
    out();
    out(`  ${yellow(glyph.todo)} No exercise matches ${bold(input)}.`);
    out(dim("  Try an ID such as py-2-06, chapter shorthand such as 2.6, or browse the chapters."));
    return undefined;
  }

  const includeBook = scope.kind !== "book";
  const picked = await choose(`Choose the exercise matching ${input}`, [
    ...result.examples.map((example) => ({ key: example.id, label: exerciseLabel(example, log, includeBook) })),
    { key: "back", label: "Cancel this search" },
  ]);
  if (!picked || picked === "back") return undefined;
  return result.examples.find((example) => example.id === picked);
}

function renderProgressOverview(title: string, counts: ReturnType<typeof report>["overall"]): void {
  out();
  out(`  ${bold(`${title} progress`)}`);
  out(`  ${bar(counts.fraction)} ${bold(`${Math.round(counts.fraction * 100)}%`)} ${dim(
    `${counts.done}/${counts.total} done, ${counts.skipped} skipped, ${counts.remaining} remaining`,
  )}`);
}

async function readExercise(
  example: Example,
  content: Content,
  confirmation: ConfirmationSession,
  planning: PlanningSession,
  dependencies: DependencySession,
  renderOptions: TerminalRenderOptions,
): Promise<void> {
  const step = finalResponse(example);
  const reply = respond(
    { messages: [{ role: "user", content: `aifirst show ${step.id}` }], tools: TOOLS },
    content,
    readLog(),
    { language: example.language, confirmation, planning, dependencies },
  );
  await renderReply(reply, renderOptions);
}

async function postLessonMenu(
  example: Example,
  step: ReplayStep,
  result: ExerciseDriveResult,
  content: Content,
  confirmation: ConfirmationSession,
  planning: PlanningSession,
  dependencies: DependencySession,
  renderOptions: TerminalRenderOptions,
): Promise<PostLessonAction> {
  while (true) {
    const entry = readLog().exercises[example.id];
    const completed = entry?.status === "done";
    const skipped = entry?.status === "skipped" && !result.failed;
    const retry = !completed && !skipped;
    const heading = completed ? "Lesson complete" : skipped ? "Lesson finished" : "Lesson paused";
    if (skipped) out(dim(`  ${example.id} ran, but it remains marked skipped in your progress.`));
    const picked = await choose(heading, [
      {
        key: retry ? "retry" : "next",
        label: retry ? "Try this exercise again" : "Continue to the next exercise",
      },
      { key: "menu", label: "Return to the learning menu" },
      { key: "review", label: "Review this exercise" },
      { key: "exit", label: "Exit learning" },
    ]);
    if (!picked || picked === "menu") return "menu";
    if (picked === "exit") return "exit";
    if (picked === "retry") return "retry";
    if (picked === "next") return "next";
    await readExercise(example, content, confirmation, planning, dependencies, renderOptions);
  }
}

async function runOrFinishExercise(
  example: Example,
  step: ReplayStep,
  content: Content,
  confirmation: ConfirmationSession,
  planning: PlanningSession,
  dependencies: DependencySession,
  renderOptions: TerminalRenderOptions,
  preparedInto?: string,
): Promise<"completed" | "retry" | "menu" | "exit"> {
  let failed = false;
  while (true) {
    const picked = await choose(failed ? "The program did not run cleanly" : "Your program is ready", [
      { key: "run", label: failed ? "Try running it again" : "Run the program" },
      { key: "finish", label: "Finish without running" },
      { key: "review", label: "Review the exercise and code" },
      { key: "menu", label: "Return to the learning menu" },
      { key: "exit", label: "Exit learning" },
    ]);
    if (!picked || picked === "menu") return "menu";
    if (picked === "exit") return "exit";
    if (picked === "review") {
      await readExercise(example, content, confirmation, planning, dependencies, renderOptions);
      continue;
    }
    if (picked === "finish") {
      mark(example.id, { via: "self" });
      out(`  ${green(glyph.done)} Finished ${bold(example.id)} without launching the program.`);
      await renderExerciseExplanation(step, renderOptions, "The final run was skipped.");
      return "completed";
    }

    out();
    out(`  ${cyan(glyph.arrow)} ${bold(`Running ${step.id}`)}`);
    const tui = currentTuiSession();
    const externalWindow = opensExternalWindow(step);
    const result = tui
      ? externalWindow
        ? await tui.withProgramRunning(
            `Running ${example.title}`,
            (signal) => runExercise(step.id, preparedInto, true, signal),
          )
        : await tui.suspendDuring(() => runExercise(step.id, preparedInto))
      : await runExercise(step.id, preparedInto, externalWindow);
    if (result.failed) {
      failed = true;
      out(`  ${red(glyph.todo)} The program did not run cleanly.`);
      continue;
    }
    await renderExerciseExplanation(step, renderOptions);
    return "completed";
  }
}

async function renderExerciseExplanation(
  step: ReplayStep,
  options: TerminalRenderOptions,
  note?: string,
): Promise<void> {
  const explanation = step.explanation;
  const markdown = explanation
    ? [
        "## What happened",
        "",
        ...(note ? [note, ""] : []),
        explanation.summary,
        ...explanation.lines.flatMap((line) => ["", `- \`${line.code.trim()}\` — ${line.text}`]),
      ].join("\n")
    : ["## What happened", "", ...(note ? [note, ""] : []), "The program is ready in your learning workspace."].join("\n");
  await renderTerminalMarkdown(markdown, options);
}

async function renderExerciseIntroduction(
  example: Example,
  step: ReplayStep,
  options: TerminalRenderOptions,
): Promise<void> {
  if (!currentTuiSession()) process.stdout.write("\n");
  await renderTerminalMarkdown(exerciseIntroduction(example, step), options);
  if (!currentTuiSession()) process.stdout.write("\n");
}

export function exerciseIntroduction(example: Example, step: ReplayStep): string {
  return [
    `## ${step.id}: ${example.title}`,
    "",
    `${example.bookTitle} ${glyph.bullet} ${example.chapterTitle}`,
    "",
    "**Exercise prompt**",
    "",
    step.prompt,
  ].join("\n");
}

async function driveExercise(
  prompt: string,
  content: Content,
  language: string | undefined,
  confirmation: ConfirmationSession,
  planning: PlanningSession,
  dependencies: DependencySession,
  renderOptions: TerminalRenderOptions,
  step: ReplayStep,
): Promise<ExerciseDriveResult> {
  const messages: RequestMessage[] = [{ role: "user", content: prompt }];
  const shownCode = new Set<string>();
  let failed = false;
  let readyToRun = false;
  let preparedWithoutRun = false;
  let preparedInto: string | undefined;
  const replayState = new ReplayStateGuard(content, step);

  for (let turn = 0; turn < 200; turn++) {
    const reply = respond(
      { messages, tools: TOOLS },
      content,
      readLog(),
      { language, confirmation, planning, dependencies, deferNativeCompletion: true, relaxCommandOutput: true },
    );
    if (!preparedWithoutRun || reply.nativeReady || reply.toolUse) {
      await renderReply(reply, renderOptions);
    }
    readyToRun ||= reply.nativeReady === true;
    if (!reply.toolUse) return { failed, readyToRun, ...(preparedInto ? { preparedInto } : {}) };

    const id = reply.toolUse.id ?? `aifirst_native_${crypto.randomUUID()}`;
    messages.push({
      role: "assistant",
      content: [
        ...(reply.text ? [{ type: "text", text: reply.text }] : []),
        { type: "tool_use", id, name: reply.toolUse.name, input: reply.toolUse.input },
      ],
    });
    await renderActionCodeBefore(reply.toolUse.nativeAction, content, renderOptions, shownCode);
    const result = await executeTool(reply.toolUse.nativeAction, reply.toolUse.input, replayState, step);
    preparedWithoutRun ||= result.prepared === true;
    preparedInto = result.preparedInto ?? preparedInto;
    failed ||= result.failed;
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
  if (!currentTuiSession()) process.stdout.write("\n");
  await renderTerminalMarkdown(reply.text, options);
  if (!currentTuiSession()) process.stdout.write("\n");
}

async function executeTool(
  action: NativeLearnAction | undefined,
  input: Record<string, unknown>,
  replayState: ReplayStateGuard,
  step: ReplayStep,
): Promise<ToolExecutionResult> {
  if (!action) return answerQuestions(input);

  try {
    if (action.kind === "replay-operation") {
      if (action.operation.type === "command") {
        const run = aifirstRunCommand(action.operation.command);
        if (run) return prepareNativeExercise(run.id, run.into);
      }
      if (action.operation.type === "write" || action.operation.type === "edit") {
        const decision = replayState.decide(action.operation, process.cwd());
        if (decision.kind === "reject") {
          return {
            failed: true,
            content: `${decision.path} already exists with different contents, so the replay left it alone.`,
          };
        }
        if (decision.kind === "already-applied") {
          const text = `Already applied ${action.operation.path}`;
          out(`  ${green(glyph.done)} ${text}`);
          return { failed: false, content: text, files: [decision.path] };
        }
      }
      const operation = nativeReplayOperation(action.operation, step);
      const result = executeReplayOperation(operation, process.cwd());
      const failed = replayOperationFailed(action.operation, result);
      out(`  ${failed ? red(glyph.todo) : green(glyph.done)} ${result.text.split("\n")[0]}`);
      return {
        failed,
        content: summarizeReplayResult(action.operation, result.text, result.command?.stdout),
        files: result.files,
      };
    }

    if (action.kind === "install-dependencies") {
      const { content } = resolveContent();
      const step = content.steps.find((candidate) => candidate.id === action.stepId) as ReplayStep | undefined;
      if (!step) return { failed: true, content: `Unknown exercise ${action.stepId}` };
      const tui = currentTuiSession();
      const stepDependencies = declaredDependencies(step);
      const installsSystemTool = stepDependencies.some((dependency) => dependency.kind === "system-command");
      const installed = tui && installsSystemTool
        ? await tui.suspendDuring(() => installDependencies(stepDependencies))
        : await installDependencies(stepDependencies);
      if (installed.ok) out(`  ${green(glyph.done)} installed ${dependencyNames(stepDependencies)}`);
      return { failed: !installed.ok, content: JSON.stringify({ ok: installed.ok, output: installed.output }) };
    }

    return prepareNativeExercise(action.stepId);
  } catch (error) {
    return { failed: true, content: (error as Error).message };
  }
}

function prepareNativeExercise(stepId: string, into?: string): ToolExecutionResult {
  const { content } = resolveContent();
  const step = content.steps.find((candidate) => candidate.id === stepId);
  const example = step ? content.examples.find((candidate) => candidate.id === step.exampleId) : undefined;
  if (!step || !example) return { failed: true, content: `Unknown exercise ${stepId}` };
  try {
    const prepared = prepareExerciseFiles(content, example, step, { into: into ?? exercisePath(example, step) });
    out(`  ${green(glyph.done)} ${prepared.wrote ? "Wrote" : "Prepared"} ${prepared.path}`);
    return {
      failed: false,
      prepared: true,
      preparedInto: prepared.path,
      content: JSON.stringify({ prepared: true, exerciseId: example.id, stepId: step.id, path: prepared.path }),
      files: [prepared.path, ...prepared.scaffoldFiles],
    };
  } catch (error) {
    return { failed: true, content: (error as Error).message };
  }
}

export function replayOperationFailed(
  operation: ReplayOperation,
  result: ReplayOperationExecution,
): boolean {
  if (operation.type !== "command") return !result.ok;
  return (result.command?.exitCode ?? 127) !== (operation.expectedExitCode ?? 0);
}

export function nativeReplayOperation(
  operation: Extract<NativeLearnAction, { kind: "replay-operation" }>["operation"],
  step: ReplayStep,
): Extract<NativeLearnAction, { kind: "replay-operation" }>["operation"] {
  if (operation.type !== "command") return operation;
  if (aifirstRunId(operation.command)) {
    return { ...operation, command: selfCommand(operation.command.slice(1).filter((argument) => argument !== "--force")) };
  }
  const entrypoint = step.scaffold?.entrypoint;
  const launchesGraphicalEntrypoint = Boolean(
    entrypoint &&
    opensExternalWindow(step) &&
    operation.command.some((argument) => argument.includes(entrypoint) && /(?:python|timeout)/.test(argument)),
  );
  if (!launchesGraphicalEntrypoint) return operation;
  return {
    ...operation,
    env: {
      ...operation.env,
      SDL_VIDEODRIVER: "dummy",
      SDL_AUDIODRIVER: "dummy",
    },
  };
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
  if (!files?.[0]) return;
  const tui = currentTuiSession();
  if (tui) {
    tui.appendDiff(action.operation.path, action.operation.oldText, action.operation.newText);
    return;
  }
  if (!currentTuiSession()) process.stdout.write("\n");
  await renderTerminalMarkdown(editDiff(action.operation.path, action.operation.oldText, action.operation.newText), options);
  if (!currentTuiSession()) process.stdout.write("\n");
}

export function editDiff(path: string, oldText: string, newText: string): string {
  return [
    `## Edit - \`${path}\``,
    "",
    "```diff",
    unifiedPatch(path, oldText, newText),
    "```",
  ].join("\n");
}

async function renderCode(
  code: string,
  language: string,
  options: TerminalRenderOptions,
  path?: string,
): Promise<void> {
  const fence = code.includes("```") ? "````" : "```";
  const title = path ? `## Code - \`${path}\`` : "## Code";
  if (!currentTuiSession()) process.stdout.write("\n");
  await renderTerminalMarkdown(`${title}\n\n${fence}${language}\n${code.replace(/\n+$/, "")}\n${fence}`, options);
  if (!currentTuiSession()) process.stdout.write("\n");
}

function aifirstRunCommand(command: string[]): { id: string; into?: string } | undefined {
  const executable = command[0]?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "");
  if (executable !== "aifirst" || command[1] !== "run") return undefined;
  const id = command[2];
  if (!id) return undefined;
  const intoIndex = command.indexOf("--into");
  const assigned = command.find((argument) => argument.startsWith("--into="))?.slice("--into=".length);
  const into = intoIndex >= 0 ? command[intoIndex + 1] : assigned;
  return { id, ...(into ? { into } : {}) };
}

function aifirstRunId(command: string[]): string | undefined {
  return aifirstRunCommand(command)?.id;
}

function languageForPath(path: string): string {
  if (path.split(/[\\/]/).at(-1)?.toLowerCase() === "pom.xml") return "maven";
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

export function opensExternalWindow(step: ReplayStep): boolean {
  return Boolean(
    step.scaffold?.entrypoint &&
    step.dependencies?.some((dependency) => dependency.kind === "python-package" && dependency.module === "pygame"),
  );
}

async function runExercise(
  stepId: string,
  into?: string,
  noTimeout = false,
  signal?: AbortSignal,
): Promise<{ failed: boolean; content: string }> {
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
    const missingPython = report.missing.some((dependency) => dependency.kind === "python-package");
    if (missingPython && !report.runtime) return { failed: true, content: report.error ?? "Python 3 is unavailable." };
    const accepted = await confirm(
      `Install ${dependencyNames(report.missing)} now?`,
      "You can return Home without changing files.",
    );
    if (!accepted) return { failed: true, content: "Dependency installation was cancelled." };
    const tui = currentTuiSession();
    const installsSystemTool = report.missing.some((dependency) => dependency.kind === "system-command");
    const installed = tui && installsSystemTool
      ? await tui.suspendDuring(() => installDependencies(step.dependencies, report.runtime))
      : await installDependencies(step.dependencies, report.runtime);
    if (!installed.ok) return { failed: true, content: installed.output };
  }

  const argv = selfCommand([
    "run",
    stepId,
    ...(into ? ["--into", into] : []),
    "--yes",
    "--format",
    "json",
    ...(noTimeout ? ["--no-timeout"] : []),
  ]);
  const proc = Bun.spawn(argv, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
    env: noTimeout ? { ...process.env, AIFIRST_LEARN_FINAL_RUN: "1" } : process.env,
    detached: Boolean(signal && process.platform !== "win32"),
  });
  const stopProgram = () => {
    if (proc.exitCode !== null) return;
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
      return;
    }
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill("SIGTERM");
    }
    setTimeout(() => {
      if (proc.exitCode !== null) return;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }, 1_000).unref();
  };
  signal?.addEventListener("abort", stopProgram, { once: true });
  if (signal?.aborted) stopProgram();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  signal?.removeEventListener("abort", stopProgram);
  const detail = `${stdout}${stderr}`.trim();
  if (signal?.aborted) return { failed: true, content: detail || "Program stopped by the learner." };
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
