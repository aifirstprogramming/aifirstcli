/** End-to-end Showtail JSON -> imported content -> aifirst learn fidelity test. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const contentRepo =
  process.env.AIFIRST_CONTENT_REPO ??
  join(import.meta.dir, "..", "..", "aifirstcontent");
const fixture = join(contentRepo, "test", "fixtures", "rocket-showtail");
const books = join(fixture, "generated", "books");
const oraclePath = join(fixture, "oracle", "claude-session.jsonl");
const sourceRoot = join(fixture, "bundle", "source");
const claude = Bun.which("claude");
const available = Boolean(
  process.env.AIFIRST_ROCKET_E2E === "1" &&
  claude &&
  existsSync(oraclePath) &&
  existsSync(join(books, "rocket-python.json")),
);
const describeE2E = available ? describe : describe.skip;

if (!available) {
  console.warn(
    "rocket-showtail-e2e: set AIFIRST_ROCKET_E2E=1 with Claude and the sibling fixture to run the full client replay.",
  );
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { content?: string | ContentBlock[] };
  toolUseResult?: Record<string, unknown>;
}

type CanonicalEvent =
  | { type: "text"; text: string }
  | {
      type: "question";
      question: string;
      header: string;
      options: Array<{
        label: string;
        description: string;
        recommended: boolean;
      }>;
      answer: string;
    }
  | { type: "plan"; plan: string }
  | { type: "approval" }
  | { type: "tool"; name: string; input: unknown }
  | {
      type: "result";
      command: string;
      exitCode: number;
      stdout?: string;
      stderr?: string;
    };
type CanonicalToolEvent = Extract<CanonicalEvent, { type: "tool" }>;

function normalize(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(
      /\/tmp\/(?:aifirst-rocket-capture-[^/]+|tmp\.[^/]+)\/workspace/g,
      "<workspace>",
    )
    .replace(
      /\\tmp\\(?:aifirst-rocket-capture-[^\\]+|tmp\.[^\\]+)\\workspace/g,
      "<workspace>",
    )
    .replace(/Ran (\d+) tests in \d+(?:\.\d+)?s/g, "Ran $1 tests in <time>s")
    .trim();
}

function option(
  label: string,
  description: string,
): { label: string; description: string; recommended: boolean } {
  const recommended = /\((?:Book )?Recommended\)$/i.test(label);
  return {
    label: label.replace(/\s*\((?:Book )?Recommended\)$/i, ""),
    description: normalize(description),
    recommended,
  };
}

function unwrapCommand(command: string): string {
  const match = /^bash -lc '([\s\S]*)'$/.exec(command);
  return normalize((match?.[1] ?? command).replace(/'\\''/g, "'")).replace(
    /<workspace>/g,
    ".",
  );
}

function canonicalTool(
  name: string,
  input: Record<string, unknown>,
): CanonicalToolEvent | undefined {
  const lower = name.toLowerCase();
  if (lower === "write" || lower === "read" || lower === "edit") {
    const rawPath = String(input.file_path ?? input.path ?? "");
    if (
      !rawPath ||
      (!rawPath.endsWith("rocket_sim.py") &&
        !rawPath.endsWith("test_rocket_sim.py"))
    )
      return undefined;
    if (lower === "write")
      return {
        type: "tool",
        name: "Write",
        input: {
          path: basename(rawPath),
          content: normalize(String(input.content ?? "")),
        },
      };
    if (lower === "read")
      return { type: "tool", name: "Read", input: { path: basename(rawPath) } };
    return {
      type: "tool",
      name: "Edit",
      input: {
        path: basename(rawPath),
        oldText: normalize(String(input.old_string ?? input.oldText ?? "")),
        newText: normalize(String(input.new_string ?? input.newText ?? "")),
        replaceAll: input.replace_all === true || input.replaceAll === true,
      },
    };
  }
  if (lower === "bash")
    return {
      type: "tool",
      name: "Bash",
      input: { command: unwrapCommand(String(input.command ?? "")) },
    };
  return undefined;
}

function canonicalBashResult(
  command: string,
  result: Record<string, unknown>,
  isError: boolean | undefined,
): CanonicalEvent {
  const normalizedCommand = unwrapCommand(command);
  const dynamicPreflight = normalizedCommand.startsWith("ls -la ");
  return {
    type: "result",
    command: normalizedCommand,
    exitCode:
      isError === false ? 0 : Number(result.exitCode ?? result.exit_code ?? 1),
    ...(!dynamicPreflight
      ? {
          stdout: normalize(String(result.stdout ?? "")),
          stderr: normalize(String(result.stderr ?? "")),
        }
      : {}),
  };
}

function canonicalOracle(raw: string): CanonicalEvent[] {
  const lines = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TranscriptLine];
      } catch {
        return [];
      }
    });
  const results = new Map<string, TranscriptLine>();
  for (const line of lines) {
    const content = Array.isArray(line.message?.content)
      ? line.message.content
      : [];
    for (const block of content)
      if (block.type === "tool_result" && block.tool_use_id)
        results.set(block.tool_use_id, line);
  }

  const events: CanonicalEvent[] = [];
  for (const line of lines) {
    if (line.isSidechain || line.isMeta || line.type !== "assistant") continue;
    const content = Array.isArray(line.message?.content)
      ? line.message.content
      : [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        events.push({ type: "text", text: normalize(block.text) });
        continue;
      }
      if (block.type !== "tool_use" || !block.name || !block.id) continue;
      if (block.name === "AskUserQuestion") {
        const rawQuestion = Array.isArray(block.input?.questions)
          ? (block.input!.questions[0] as Record<string, unknown>)
          : undefined;
        const result = results.get(block.id)?.toolUseResult ?? {};
        const answers = result.answers as Record<string, string> | undefined;
        const question = String(rawQuestion?.question ?? "");
        events.push({
          type: "question",
          question,
          header: String(rawQuestion?.header ?? "").slice(0, 12),
          options: (Array.isArray(rawQuestion?.options)
            ? rawQuestion!.options
            : []
          ).map((rawOption) => {
            const value = rawOption as Record<string, unknown>;
            return option(
              String(value.label ?? ""),
              String(value.description ?? ""),
            );
          }),
          answer: option(String(answers?.[question] ?? ""), "").label,
        });
        continue;
      }
      if (block.name === "ExitPlanMode") {
        events.push({
          type: "plan",
          plan: normalize(String(block.input?.plan ?? "")),
        });
        events.push({ type: "approval" });
        continue;
      }
      const tool = canonicalTool(block.name, block.input ?? {});
      if (!tool) continue;
      events.push(tool);
      if (tool.name === "Bash") {
        const resultLine = results.get(block.id);
        const resultBlock = (
          Array.isArray(resultLine?.message?.content)
            ? resultLine!.message!.content
            : []
        ).find(
          (candidate) =>
            candidate.type === "tool_result" &&
            candidate.tool_use_id === block.id,
        );
        events.push(
          canonicalBashResult(
            String(block.input?.command ?? ""),
            resultLine?.toolUseResult ?? {},
            resultBlock?.is_error,
          ),
        );
      }
    }
  }
  return events;
}

function canonicalReplay(stdout: string): CanonicalEvent[] {
  const book = JSON.parse(
    readFileSync(join(books, "rocket-python.json"), "utf8"),
  );
  const replay = book.sections[0].chapters[0].examples[0].replay;
  const workflow = replay.workflow;
  const question = workflow.questions[0];
  const selected = question.options.find(
    (candidate: { id: string }) =>
      candidate.id === workflow.canonicalAnswers[question.id],
  );
  const events: CanonicalEvent[] = [];
  const tools = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();
  for (const line of stdout.split(/\r?\n/)) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use" && block.name) {
          tools.set(block.id, { name: block.name, input: block.input ?? {} });
          const tool = canonicalTool(block.name, block.input ?? {});
          if (tool) events.push(tool);
          continue;
        }
        if (block.type !== "text" || !block.text) continue;
        const text = normalize(block.text);
        if (text.includes(question.question)) {
          const prefix = text.slice(0, text.indexOf(question.question)).trim();
          if (prefix) events.push({ type: "text", text: prefix });
          for (const candidate of question.options) {
            expect(text).toContain(candidate.label);
            expect(text).toContain(candidate.description);
          }
          events.push({
            type: "question",
            question: question.question,
            header: question.header,
            options: question.options.map(
              (candidate: { id: string; label: string; description: string }) =>
                option(
                  `${candidate.label}${candidate.id === selected.id ? " (Book Recommended)" : ""}`,
                  candidate.description,
                ),
            ),
            answer: selected.label,
          });
        } else if (text.includes("## Proposed plan")) {
          expect(text).toContain(workflow.canonicalPlan);
          events.push({
            type: "plan",
            plan: normalize(workflow.canonicalPlan),
          });
          events.push({ type: "approval" });
        } else {
          events.push({ type: "text", text });
        }
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const tool = tools.get(block.tool_use_id);
        if (tool?.name.toLowerCase() !== "bash") continue;
        events.push(
          canonicalBashResult(
            String(tool.input.command ?? ""),
            event.tool_use_result ?? {},
            block.is_error,
          ),
        );
      }
    }
  }
  return events;
}

function firstDifference(
  expected: CanonicalEvent[],
  actual: CanonicalEvent[],
): string {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index])) {
      return `event ${index}\nexpected: ${JSON.stringify(expected[index], null, 2)}\nactual: ${JSON.stringify(actual[index], null, 2)}`;
    }
  }
  return "none";
}

describeE2E("rocket Showtail replay through aifirst learn", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("matches the captured Claude conversation and source at 100%", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-rocket-replay-"));
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    mkdirSync(workspace, { recursive: true });
    const driver = join(import.meta.dir, "fixtures", "rocket-replay-driver.py");
    const proc = Bun.spawn(
      ["python3", driver, process.execPath, ENTRY, workspace, fixture],
      {
        cwd: workspace,
        env: {
          ...process.env,
          AIFIRST_CONTENT_DIR: books,
          AIFIRST_STATE_DIR: state,
          AIFIRST_LEARN_CHARS_PER_SECOND: "100000",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12000)}`).toBe(0);

    for (const path of ["rocket_sim.py", "test_rocket_sim.py"]) {
      expect(readFileSync(join(workspace, path), "utf8"), path).toBe(
        readFileSync(join(sourceRoot, path), "utf8"),
      );
    }
    const tests = Bun.spawnSync(["python3", "-m", "unittest", "-v"], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(tests.exitCode, tests.stderr.toString()).toBe(0);
    const simulation = Bun.spawnSync(["python3", "rocket_sim.py"], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(simulation.exitCode, simulation.stderr.toString()).toBe(0);
    const capture = JSON.parse(
      readFileSync(join(fixture, "capture.json"), "utf8"),
    );
    expect(simulation.stdout.toString()).toBe(capture.simulationOutput);

    const expected = canonicalOracle(readFileSync(oraclePath, "utf8"));
    const actual = canonicalReplay(stdout);
    expect(actual, firstDifference(expected, actual)).toEqual(expected);
  }, 90_000);
});
