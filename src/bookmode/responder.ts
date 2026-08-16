/**
 * What book mode answers, with no model involved.
 *
 * Everything a reader sees for a book exercise was computed and committed at
 * authoring time: the prompt, the byte-exact code, the explanation, the sample
 * input, the command that runs it. So a prompt printed in the book needs no
 * reasoning at request time — the reasoning already happened, and this turns the
 * reader's typed prompt back into that stored answer.
 *
 * Deliberately pure and HTTP-free: the whole behaviour of book mode is decided
 * here and tested without a socket. `serve.ts` only encodes what this returns.
 */

import { findMatchingStep } from "@aifirst/content";
import { chatCommandError, isLocalCommand, localHelp, parseChatCommand } from "./commands";
import type { ContentSource, SourceState } from "./contentSource";
import { renderStep } from "./render";
import type { Content } from "../content/types";
import type { ProgressLog } from "../log/progress";

/** The subset of an Anthropic request this needs. Everything else is ignored. */
export interface MessagesRequest {
  model?: string;
  stream?: boolean;
  messages?: RequestMessage[];
  tools?: ToolDefinition[];
}

export interface RequestMessage {
  role: string;
  content?: string | ContentBlock[];
}

export interface ContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name?: string;
  input_schema?: { properties?: Record<string, unknown>; required?: string[] };
}

export interface Reply {
  text: string;
  /** Present when the reply asks the client to run the exercise. */
  toolUse?: { name: string; input: Record<string, unknown> };
  stopReason: "end_turn" | "tool_use";
  /** Which exercise this answered, when it answered one. Used only for logging. */
  exerciseId?: string;
}

/**
 * The tool the client offers for running a shell command.
 *
 * Discovered from the request rather than hard-coded. Claude Code sent 24 tools in
 * the spike and calls this one `Bash` today, but a name we hard-coded would be a
 * silent breakage the first time it changed. A tool taking a `command` string is
 * the thing we actually need, so that is what we look for.
 */
export function shellTool(tools: ToolDefinition[] | undefined): string | undefined {
  for (const tool of tools ?? []) {
    if (!tool?.name) continue;
    const props = tool.input_schema?.properties ?? {};
    const command = props.command as { type?: string } | undefined;
    if (command && (command.type === undefined || command.type === "string")) return tool.name;
  }
  return undefined;
}

/** Blocks a client injects around what the reader typed. */
const INJECTED = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

/**
 * What the reader actually typed, out of the last user turn.
 *
 * A client's user message carries more than the reader's words — reminders,
 * file context, tool results. Matching against all of it would let a short book
 * prompt match incidentally, because the matcher accepts one string containing
 * the other.
 */
export function readerText(messages: RequestMessage[] | undefined): string {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  if (!last) return "";

  const raw =
    typeof last.content === "string"
      ? last.content
      : (last.content ?? [])
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n");

  return raw.replace(INJECTED, "").trim();
}

/** The result of a tool we asked the client to run, if that is what just arrived. */
export function toolResult(
  messages: RequestMessage[] | undefined,
): { failed: boolean; detail: string } | undefined {
  const last = (messages ?? [])[(messages ?? []).length - 1];
  if (!last || typeof last.content === "string") return undefined;
  const block = (last.content ?? []).find((b) => b?.type === "tool_result");
  if (!block) return undefined;

  const raw = block.content;
  const detail =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? (raw as ContentBlock[])
            .filter((b) => typeof b?.text === "string")
            .map((b) => b.text as string)
            .join("\n")
        : "";
  return { failed: block.is_error === true, detail: detail.trim() };
}

/** Did the client just hand back the result of a tool we asked it to run? */
export function carriesToolResult(messages: RequestMessage[] | undefined): boolean {
  return toolResult(messages) !== undefined;
}


/**
 * What to say once the exercise has run — or failed to.
 *
 * The command's result is checked rather than assumed. Saying "recorded" because a
 * tool call came back is how a reader ends up with a green tick for code that never
 * ran, which is a bug this project has already shipped once.
 */
function closing(log: ProgressLog, content: Content, result: { failed: boolean; detail: string }): string {
  const done = Object.values(log.exercises).filter((e) => e.status === "done").length;
  const total = content.examples.length;

  if (result.failed) {
    const approval = /requires approval|permission/i.test(result.detail);
    const lines = [
      approval
        ? "That was not allowed to run, so nothing has been recorded."
        : "That did not run cleanly, so nothing has been recorded.",
    ];
    if (result.detail) {
      lines.push("", "```", result.detail.slice(0, 500), "```");
    }
    lines.push(
      "",
      approval
        ? "Approve it, or run `aifirst init` once to pre-approve the aifirst commands."
        : "Fix it and ask again, or run the command yourself to see the full output.",
    );
    return lines.join("\n");
  }

  return [
    `Ran clean — ${done} of ${total} exercises done.`,
    "",
    "Ask for the next one, or run `aifirst next` yourself.",
  ].join("\n");
}

/**
 * The refusal.
 *
 * Book mode answers from the pack or not at all. Quietly forwarding an unmatched
 * question to the real API would spend the reader's money in a mode they turned on
 * precisely so that it wouldn't, so the reply says what happened and how to leave.
 */
function refusal(typed: string): string {
  const asked = typed.length > 0 && typed.length < 120 ? `“${typed}” ` : "";
  return [
    `Book mode is on, and ${asked}isn't a prompt from the book.`,
    "",
    "It answers only what the books contain, from content shipped with the CLI —" +
      " no model is running and nothing leaves this machine, which is why it costs nothing.",
    "",
    "You can:",
    "- ask for an exercise using its prompt from the page, or by id (`py-1-01`)",
    "- type `aifirst next` (no leading slash) to see what's next",
    "- run `aifirst book-mode off` to go back to the real Claude, which costs the usual",
  ].join("\n");
}

function chatReply(
  typed: string,
  content: Content,
  log: ProgressLog,
  tools: ToolDefinition[] | undefined,
  language: string | undefined,
): Reply | undefined {
  const command = parseChatCommand(typed);
  if (!command) {
    return /\baifirst\b/i.test(typed)
      ? { text: chatCommandError(""), stopReason: "end_turn" }
      : undefined;
  }
  if (!isLocalCommand(command.command)) {
    return { text: chatCommandError(command.command), stopReason: "end_turn" };
  }
  if (command.command === "help") return { text: localHelp(), stopReason: "end_turn" };

  if (command.command === "show" || command.command === "prompt") {
    const id = command.positionals[0];
    const step = id ? content.steps.find((item) => item.id === id) : undefined;
    const example = step ? content.examples.find((item) => item.id === step.exampleId) : undefined;
    if (step && example) return { text: renderStep(example, step), stopReason: "end_turn", exerciseId: step.id };
    return { text: "local learning could not find that exercise. Try `aifirst show py-1-01`.", stopReason: "end_turn" };
  }

  if (command.command === "next") {
    const next = content.examples.find(
      (example) => !log.exercises[example.id] && (!language || example.language === language),
    );
    if (!next) return { text: "No next exercise is available.", stopReason: "end_turn" };
    const step = content.steps.find((item) => item.exampleId === next.id);
    if (!step) return { text: "local learning could not find the next exercise content.", stopReason: "end_turn" };
    const tool = shellTool(tools);
    const commandText = `aifirst run ${step.id}`;
    return {
      text: [
        renderStep(next, step),
        "",
        "## Instruction",
        "",
        step.prompt,
        ...(tool ? [] : ["", "Run it with:", "", "```", commandText, "```"]),
      ].join("\n"),
      ...(tool
        ? {
            toolUse: {
              name: tool,
              input: { command: commandText, description: `Run ${step.id} and record it` },
            },
          }
        : {}),
      stopReason: tool ? "tool_use" : "end_turn",
      exerciseId: next.id,
    };
  }

  return {
    text: `local learning accepts \`aifirst ${command.command}\`. Run the same command in your terminal for its full output.`,
    stopReason: "end_turn",
  };
}

export interface RespondOptions {
  /** Restrict matching to the reader's book, so a Python reader never gets Java. */
  language?: string;
}

/**
 * The book pack's own matching logic, wrapped behind the ContentSource seam.
 *
 * A 1:1 wrap of what `respond()` did inline before this seam existed: find the
 * matching step, render it, and offer the client's own shell tool to run it.
 */
export class BookContentSource implements ContentSource {
  constructor(
    private readonly content: Content,
    private readonly tools: ToolDefinition[] | undefined,
    private readonly language: string | undefined,
  ) {}

  next(typed: string) {
    const step = typed ? findMatchingStep(typed, this.content.steps, this.language) : null;
    if (!step) return undefined;

    const example = this.content.examples.find((e) => e.id === step.exampleId);
    if (!example) {
      // A step whose example is missing is a content bug, not something to dress
      // up as an answer.
      return undefined;
    }

    const tool = shellTool(this.tools);
    const command = `aifirst run ${step.id}`;
    if (!tool) {
      // No shell tool on offer: still give the reader the answer and the
      // command, rather than a tool call the client cannot execute.
      return {
        text: `${renderStep(example, step)}\n\nRun it with:\n\n\`\`\`\n${command}\n\`\`\``,
        stopReason: "end_turn" as const,
        exerciseId: step.id,
      };
    }

    return {
      text: renderStep(example, step),
      toolUse: { name: tool, input: { command, description: `Run ${step.id} and record it` } },
      stopReason: "tool_use" as const,
      exerciseId: step.id,
    };
  }
}

/** Decide what book mode replies to one request. */
export function respond(
  request: MessagesRequest,
  content: Content,
  log: ProgressLog,
  options: RespondOptions = {},
  source: ContentSource = new BookContentSource(content, request.tools, options.language),
): Reply {
  const result = toolResult(request.messages);
  if (result) {
    return { text: closing(log, content, result), stopReason: "end_turn" };
  }

  const typed = readerText(request.messages);
  const chat = chatReply(typed, content, log, request.tools, options.language);
  if (chat) return chat;

  const state: SourceState = {};
  const reply = source.next(typed, state);
  if (!reply) {
    return { text: refusal(typed), stopReason: "end_turn" };
  }
  return reply;
}
