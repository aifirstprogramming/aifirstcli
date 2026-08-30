import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, relative } from "node:path";
import type { Args } from "../cli";
import { boolFlag, stringFlag } from "../cli";
import { replayDir } from "../paths";
import { CliError, errLine, json, out, table } from "../output";
import { buildReplayPack } from "../replay/importer";
import { replayRunArgs, runReplay } from "../replay/runner";
import { parseShowtailReport } from "../replay/showtailReport";
import { loadReplayPack, packPath, replayExists, resetReplay } from "../replay/store";
import { renderReplayStep } from "../replay/contentSource";
import type { ReplayPack } from "../replay/types";
import { resolveContent } from "../content";
import { executeReplay } from "../replay/executor";
import { resolveReplay } from "../replay/resolver";
import { clearPendingReplay, readPendingReplay, replaySelection, savePendingReplay } from "../replay/pending";
import type { ReplayStep } from "../content/types";
import { markIfNew } from "../log/progress";

function sanitizeCapturedText(value: string): string {
  return value
    .replace(/`[A-Za-z]:\\[^`]+`/g, "`.`")
    .replace(/[A-Za-z]:\\Users\\[^\\\s`]+\\savetheduckling/g, ".")
    .replace(/\bsavetheduckling\//g, "./");
}

function workflowContext(step: ReplayStep, root: string): string {
  const replay = step.replay!;
  const workflow = replay.workflow!;
  const questions = workflow.questions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({
      ...option,
      label: `${option.label}${workflow.canonicalAnswers[question.id] === option.id ? " (Book Recommended)" : ""}`,
    })),
  }));
  const questionSteps: Array<Record<string, unknown>> = [];
  for (let index = 0; index < questions.length;) {
    const question = questions[index];
    if (!question.group) {
      questionSteps.push({ kind: "question", question });
      index++;
      continue;
    }
    const grouped = [];
    while (index < questions.length && questions[index].group === question.group) grouped.push(questions[index++]);
    questionSteps.push({ kind: "group", group: question.group, questions: grouped });
  }
  return [
    `AI First planning workflow for ${step.id}.`,
    "Enter Claude Code native plan mode before asking questions. If native plan mode is unavailable, emulate it and do not write files or run commands before approval.",
    "Follow `questionSteps` exactly. For a `group`, ask only that step's questions together in one AskUserQuestion call. For a `question`, ask it separately and only after its `when` conditions are satisfied by earlier answers. Never merge an ungrouped or conditional question into the preceding group. Preserve option order and display the supplied `(Book Recommended)` suffix verbatim; do not add another recommendation label.",
    "If all answers match `canonicalAnswers`, present `canonicalPlan` and, after approval, execute `canonicalReplay` exactly and verify every result.",
    `Treat every replay path as relative to the current working directory (${root}). Never mention, recreate, or apologize for a captured absolute path.`,
    "If any answer differs, explicitly identify the differences, create a tailored plan, obtain approval, implement and verify that adaptive variant, then record it with `aifirst done <id> --via agent --agent claude --variant-json <json> --format json`.",
    "The variant JSON must be `{\"kind\":\"adaptive\",\"answers\":{...}}` and contain only stable question and option ids. Do not store free-form user text.",
    "Never claim completion until the selected implementation has run successfully.",
    JSON.stringify({
      exerciseId: step.id,
      questionSteps,
      canonicalAnswers: workflow.canonicalAnswers,
      canonicalPlan: sanitizeCapturedText(workflow.canonicalPlan),
      canonicalReplay: {
        command: `aifirst replay execute ${step.id} --format json`,
        capturedCommentary: replay.events
          ?.filter((event) => event.type !== "operation")
          .map((event) => sanitizeCapturedText(event.text)),
      },
      authoredVariants: workflow.variants ?? [],
    }, null, 2),
  ].join("\n\n");
}

function ambiguousReplayChoices(content: ReturnType<typeof resolveContent>["content"], stepIds: string[]) {
  return stepIds.flatMap((id) => {
    const step = content.steps.find((candidate) => candidate.id === id) as ReplayStep | undefined;
    if (!step?.replay) return [];
    const title = content.examples.find((example) => example.id === step.exampleId)?.title ?? step.id;
    return [{ exerciseId: step.id, title, prompt: step.replay.prompt ?? step.prompt }];
  });
}

function format(args: Args): "text" | "json" { return stringFlag(args, "format") === "json" ? "json" : "text"; }
function counts(pack: ReplayPack): { steps: number; commentary: number; codeChanges: number; toolCalls: number } {
  return {
    steps: pack.steps.length,
    commentary: pack.steps.reduce((total, step) => total + step.commentary.length, 0),
    codeChanges: pack.steps.reduce((total, step) => total + step.codeChanges.length, 0),
    toolCalls: pack.steps.reduce((total, step) => total + step.toolCalls.length, 0),
  };
}

export async function replay(args: Args): Promise<void> {
  const action = (args.positionals[0] ?? "").toLowerCase();
  const output = format(args);
  if (action === "execute") {
    const id = args.positionals[1];
    if (!id) throw new CliError("Usage: aifirst replay execute <exercise-id> [--format json]", "bad_option");
    const step = resolveContent().content.steps.find((candidate) => candidate.id === id) as ReplayStep | undefined;
    if (!step?.replay) throw new CliError(`No replay found for ${id}`, "unknown_exercise");
    const root = process.cwd();
    const result = executeReplay(step.replay, root);
    if (result.ok) markIfNew(step.exampleId, { via: "agent", agent: "claude" });
    const response = {
      exerciseId: step.id,
      ok: result.ok,
      recorded: result.ok,
      files: result.files.map((file) => relative(root, file)),
      commands: result.commands.map((command, index) => ({
        index: index + 1,
        executable: command.command[0],
        exitCode: command.exitCode,
        matchesExpected: command.matchesExpected,
      })),
      completionText: step.replay.completionText ? sanitizeCapturedText(step.replay.completionText) : undefined,
    };
    if (output === "json") json(response);
    else out(result.ok ? `Replay ${step.id} completed and was recorded.` : `Replay ${step.id} diverged from its captured result.`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === "import") {
    const source = args.positionals[1];
    const name = stringFlag(args, "name") ?? args.positionals[2];
    if (!source || !name) throw new CliError("Usage: aifirst replay import <report.json> --name <name>", "bad_option");
    const target = packPath(name);
    if (replayExists(name) && !boolFlag(args, "force")) throw new CliError(`Replay "${name}" already exists`, "already_exists", "Pass --force to replace it.");
    const pack = buildReplayPack(name, parseShowtailReport(JSON.parse(readFileSync(source, "utf8"))));
    mkdirSync(replayDir(), { recursive: true });
    writeFileSync(target, JSON.stringify(pack, null, 2) + "\n", { mode: 0o600 });
    // Unconditional: the privacy warning must reach the user regardless of
    // --format, so it goes to stderr and stays out of the JSON stdout contract
    // that machine consumers parse.
    errLine("WARNING: this report may contain another person's real prompts, files, and tool output. Showtail redaction is best-effort, not guaranteed.");
    const summary = counts(pack);
    if (output === "json") json({ imported: name, ...summary });
    else out(`Imported replay ${name} (${summary.steps} steps, ${summary.commentary} outputs, ${summary.codeChanges} changes, ${summary.toolCalls} tools).`);
    return;
  }
  if (action === "list") {
    const rows: [string, string][] = [];
    if (existsSync(replayDir())) for (const file of readdirSync(replayDir())) {
      if (!file.endsWith(".json") || file.endsWith(".state.json")) continue;
      const pack = loadReplayPack(basename(file, ".json"));
      rows.push([pack.name, `${pack.displayName} (${pack.steps.length} steps)`]);
    }
    if (output === "json") json(rows.map(([name, detail]) => ({ name, detail })));
    else out(rows.length ? table(rows) : "No replays imported.");
    return;
  }
  if (action === "resolve" || action === "hook") {
    if (action === "hook" && process.env.AIFIRST_NATIVE_REPLAY === "1") {
      json({});
      return;
    }
    const raw = await Bun.stdin.text();
    let prompt = raw;
    let root = process.cwd();
    try {
      const input = JSON.parse(raw) as Record<string, unknown>;
      prompt = typeof input.prompt === "string" ? input.prompt : typeof input.user_prompt === "string" ? input.user_prompt : raw;
      if (typeof input.cwd === "string") root = input.cwd;
    } catch {
      // Hook tests and local callers may provide plain prompt text.
    }
    const content = resolveContent().content;
    const deferToLearnResponder = action === "hook" && process.env.IS_DEMO === "1";
    const pending = readPendingReplay(root);
    const selection = pending ? replaySelection(prompt, pending.stepIds) : undefined;
    if (selection === "cancel" && pending) {
      if (!deferToLearnResponder) clearPendingReplay(root);
      if (action === "hook") json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "The user chose not to run an AI First exercise. Do nothing." } });
      else json({ match: "cancelled" });
      return;
    }
    if (selection && selection !== "cancel" && pending) {
      const step = content.steps.find((candidate) => candidate.id === selection) as ReplayStep | undefined;
      if (step?.replay) {
        if (!deferToLearnResponder) clearPendingReplay(root);
        if (step.replay.workflow) {
          const context = workflowContext(step, root);
          if (action === "hook") json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
          else json({ match: "confirmed", exerciseId: step.id, workflow: step.replay.workflow });
          return;
        }
        const execution = process.env.IS_DEMO === "1" || action === "resolve" ? undefined : executeReplay(step.replay, root);
        const context = ["The user confirmed the pending AI First replay.", execution?.text, `Replay exercise: ${step.id}`].filter(Boolean).join("\n\n");
        if (action === "hook") json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
        else json({ match: "confirmed", exerciseId: step.id, execution: execution ?? null });
        return;
      }
      if (!deferToLearnResponder) clearPendingReplay(root);
    }
    if (pending && pending.stepIds.length > 1) {
      const choices = ambiguousReplayChoices(content, pending.stepIds);
      const context = `Several AI First exercises may match. Present these choices and a final "None of these" option, then wait. Do not run anything until the user selects one: ${JSON.stringify(choices)}`;
      if (action === "hook") json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
      else json({ match: "ambiguous", candidates: choices });
      return;
    }
    const match = resolveReplay(prompt, content);
    if (match.kind === "none") {
      if (action === "hook") json({});
      else json({ match: "none" });
      return;
    }
    if (match.kind === "fuzzy") {
      if (!deferToLearnResponder) savePendingReplay(match.step.id, root);
      const context = `A possible AI First replay matches this prompt: ${match.step.prompt}. Ask the user to confirm before running it.`;
      if (action === "hook") json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
      else json({ match: "fuzzy", exerciseId: match.step.id, prompt: match.step.prompt, score: match.score });
      return;
    }
    if (match.kind === "ambiguous") {
      const stepIds = match.candidates.map((candidate) => candidate.step.id);
      if (!deferToLearnResponder) savePendingReplay(stepIds, root);
      const choices = ambiguousReplayChoices(content, stepIds);
      const context = `Several AI First exercises may match. Present these choices and a final "None of these" option, then wait. Do not run anything until the user selects one: ${JSON.stringify(choices)}`;
      if (action === "hook") json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
      else json({ match: "ambiguous", candidates: choices });
      return;
    }
    if (match.step.replay?.workflow) {
      const context = workflowContext(match.step, root);
      if (action === "hook") json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
      else json({ match: "exact", exerciseId: match.step.id, workflow: match.step.replay.workflow });
      return;
    }
    const execution = process.env.IS_DEMO === "1" || action === "resolve" ? undefined : executeReplay(match.step.replay!, root);
    const context = [
      "This prompt exactly matches an AI First replay.",
      "Use the captured replay response verbatim; do not invent commentary or commands.",
      execution?.text,
      `Replay exercise: ${match.step.id}`,
    ].filter(Boolean).join("\n\n");
    if (action === "hook") json({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
    else json({ match: "exact", exerciseId: match.step.id, execution: execution ?? null });
    return;
  }
  const name = args.positionals[1];
  if (!name) throw new CliError("Usage: aifirst replay show|reset|run <name>", "bad_option");
  if (action === "reset") {
    resetReplay(name);
    out(`Reset replay ${name}.`);
    return;
  }
  if (action === "run") {
    if (boolFlag(args, "reset")) resetReplay(name);
    const { mode, passthrough } = replayRunArgs(args);
    await runReplay(name, mode, passthrough);
    return;
  }
  if (action === "show") {
    const pack = loadReplayPack(name);
    if (output === "json") json(pack);
    else out(pack.steps.map((step, index) => `Step ${index + 1}: ${step.promptText}\n${renderReplayStep(step)}`).join("\n\n"));
    return;
  }
  throw new CliError(`Unknown replay action "${action}"`, "bad_option", "Use import, list, show, reset, or run.");
}
