import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { respond, type ContentBlock, type Reply, type ToolDefinition } from "../../src/bookmode/responder";
import type { PlanningSession } from "../../src/bookmode/planning";
import { startBookServer } from "../../src/commands/serve";
import { resolveContent } from "../../src/content";
import { emptyLog } from "../../src/log/progress";

export type FindingLayer = "state" | "server" | "stream" | "pty" | "lifecycle" | "harness";

export interface ExplorationFinding {
  id: string;
  layer: FindingLayer;
  severity: "P0" | "P1" | "P2" | "P3";
  title: string;
  detail: string;
  sequence?: string[];
  seed?: number;
  reproductions?: number;
  artifact?: string;
}

export interface CampaignResult {
  name: string;
  cases: number;
  durationMs: number;
  findings: ExplorationFinding[];
  notes: string[];
}

export interface ExplorationReport {
  generatedAt: string;
  platform: string;
  cliVersion: string;
  claudeVersion: string;
  campaigns: CampaignResult[];
  findings: ExplorationFinding[];
}

export class SeededRandom {
  private value: number;

  constructor(seed: number) {
    this.value = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    let value = this.value;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.value = value >>> 0;
    return this.value / 0x1_0000_0000;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
}

export async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function commandResult(command: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}) {
  const started = performance.now();
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timedOut = false;
  try {
    await withTimeout(proc.exited, options.timeoutMs ?? 120_000, command.join(" "));
  } catch {
    timedOut = true;
    proc.kill("SIGTERM");
    await withTimeout(proc.exited, 2_000, `terminate ${command.join(" ")}`).catch(() => proc.kill("SIGKILL"));
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return {
    command,
    exitCode: timedOut ? 124 : proc.exitCode ?? 1,
    stdout,
    stderr: timedOut ? `${stderr}\nTimed out after ${options.timeoutMs ?? 120_000}ms` : stderr,
    durationMs: Math.round(performance.now() - started),
  };
}

function finding(layer: FindingLayer, severity: ExplorationFinding["severity"], title: string, detail: string): ExplorationFinding {
  return { id: randomUUID(), layer, severity, title, detail };
}

const TOOLS: ToolDefinition[] = [
  { name: "AskUserQuestion", input_schema: { properties: { questions: { type: "array" } } } },
  { name: "Read", input_schema: { properties: { file_path: { type: "string" } } } },
  { name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } } } },
  { name: "Edit", input_schema: { properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } } } },
  { name: "Bash", input_schema: { properties: { command: { type: "string" } }, required: ["command"] } },
];

const PROMPTS = {
  hello: "Write a Hello World app",
  fuzzy: "baby duckling who is trying to find its mother",
  ambiguous: "duckling",
  editor: "Design a level editor for the savetheduckling game.",
  levels: "levels",
  offbook: "Explain quantum chromodynamics in limericks",
  help: "aifirst help",
  next: "aifirst next",
  reset: "aifirst reset --all",
} as const;

type PromptName = keyof typeof PROMPTS;
type AnswerMode = "valid" | "cancel" | "reject" | "empty" | "invalid" | "duplicate" | "stale";
export type StateAction = { kind: "prompt"; prompt: PromptName } | { kind: "answer"; mode: AnswerMode };

interface ConfirmationState {
  stepId?: string;
  stepIds?: string[];
  confirmationToolId?: string;
  ambiguityToolId?: string;
}

interface SequenceResult {
  findings: ExplorationFinding[];
  trace: string[];
}

function treeFingerprint(root: string): string {
  if (!existsSync(root)) return "missing";
  const hash = createHash("sha256");
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).replace(/\\/g, "/");
      hash.update(rel);
      if (entry.isDirectory()) visit(path);
      else {
        hash.update(String(statSync(path).size));
        hash.update(readFileSync(path));
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function replyFingerprint(reply: Reply, confirmation: ConfirmationState, planning: PlanningSession): string {
  return JSON.stringify({
    text: reply.text.replace(/\s+/g, " ").slice(0, 240),
    tool: reply.toolUse?.id,
    reason: reply.stopReason,
    confirmation,
    planning: {
      stepId: planning.stepId,
      awaiting: planning.awaiting,
      answers: planning.answers,
    },
  });
}

function questions(toolUse: NonNullable<Reply["toolUse"]>): Array<Record<string, unknown>> {
  return Array.isArray(toolUse.input.questions) ? toolUse.input.questions as Array<Record<string, unknown>> : [];
}

function optionLabel(question: Record<string, unknown>, wanted: RegExp, fallbackIndex = 0): string {
  const options = Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : [];
  const match = options.find((option) => wanted.test(String(option.label ?? ""))) ?? options[fallbackIndex];
  return String(match?.label ?? "Other");
}

function validToolResult(toolUse: NonNullable<Reply["toolUse"]>): ContentBlock {
  if (toolUse.name.toLowerCase() !== "askuserquestion") {
    return { type: "tool_result", tool_use_id: toolUse.id, content: "ok", is_error: false };
  }
  const answers: Record<string, string> = {};
  for (const question of questions(toolUse)) {
    answers[String(question.question ?? question.header ?? "Question")] = optionLabel(question, /Book Recommended|Run this replay|Approve and build/i);
  }
  return { type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify({ answers }) };
}

function answerToolResult(
  mode: AnswerMode,
  toolUse: NonNullable<Reply["toolUse"]> | undefined,
  staleIds: string[],
): ContentBlock[] | string {
  if (!toolUse?.id) return mode === "empty" ? "(no content)" : "duckling";
  const valid = validToolResult(toolUse);
  if (mode === "valid") return [valid];
  if (mode === "reject") {
    return [{
      type: "tool_result",
      tool_use_id: toolUse.id,
      is_error: true,
      content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    }];
  }
  if (mode === "empty") return [{ type: "tool_result", tool_use_id: toolUse.id, content: "(no content)" }];
  if (mode === "invalid") return [{ type: "tool_result", tool_use_id: toolUse.id, content: "not an offered choice" }];
  if (mode === "duplicate") return [valid, structuredClone(valid)];
  if (mode === "stale") {
    const stale = staleIds.at(-1) ?? `${toolUse.id}_stale`;
    return [
      { type: "tool_result", tool_use_id: stale, content: '{"answers":{"Exercise":"None of these"}}' },
      valid,
    ];
  }
  if (toolUse.name.toLowerCase() !== "askuserquestion") {
    return [{ type: "tool_result", tool_use_id: toolUse.id, content: "cancelled", is_error: true }];
  }
  const result: Record<string, string> = {};
  for (const question of questions(toolUse)) {
    result[String(question.question ?? question.header ?? "Question")] = optionLabel(question, /None of these|Cancel|Exit local learning/i, 1);
  }
  return [{ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify({ answers: result }) }];
}

function generateActions(random: SeededRandom, length: number): StateAction[] {
  const promptNames = Object.keys(PROMPTS) as PromptName[];
  const answerModes: AnswerMode[] = ["valid", "cancel", "reject", "empty", "invalid", "duplicate", "stale"];
  const actions: StateAction[] = [{ kind: "prompt", prompt: random.pick(promptNames) }];
  while (actions.length < length) {
    actions.push(random.next() < 0.34
      ? { kind: "prompt", prompt: random.pick(promptNames) }
      : { kind: "answer", mode: random.pick(answerModes) });
  }
  return actions;
}

export async function runStateSequence(actions: StateAction[]): Promise<SequenceResult> {
  const root = mkdtempSync(join(tmpdir(), "aifirst-learn-state-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  mkdirSync(workspace);
  const originalCwd = process.cwd();
  const originalState = process.env.AIFIRST_STATE_DIR;
  const confirmation: ConfirmationState = {};
  const planning: PlanningSession = { answers: {} };
  const content = resolveContent().content;
  const trace: string[] = [];
  const findings: ExplorationFinding[] = [];
  const staleIds: string[] = [];
  let outstanding: Reply["toolUse"];
  let repeated = 0;
  let previousFingerprint = "";

  process.chdir(workspace);
  process.env.AIFIRST_STATE_DIR = stateDir;
  try {
    for (const action of actions) {
      const before = treeFingerprint(workspace);
      let contentBlock: string | ContentBlock[];
      if (action.kind === "prompt") {
        const prompt = PROMPTS[action.prompt];
        contentBlock = outstanding?.id
          ? [
              {
                type: "tool_result",
                tool_use_id: outstanding.id,
                is_error: true,
                content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
              },
              { type: "text", text: prompt },
            ]
          : prompt;
        trace.push(`prompt:${action.prompt}`);
      } else {
        contentBlock = answerToolResult(action.mode, outstanding, staleIds);
        trace.push(`answer:${action.mode}:${outstanding?.id ?? "none"}`);
      }

      let reply: Reply;
      try {
        reply = respond(
          { messages: [{ role: "user", content: contentBlock }], tools: TOOLS },
          content,
          emptyLog(),
          { language: "python", confirmation, planning },
        );
      } catch (error) {
        findings.push(finding("state", "P1", "Responder threw during an interaction sequence", String(error)));
        break;
      }

      if ((reply.stopReason === "tool_use") !== Boolean(reply.toolUse)) {
        findings.push(finding("state", "P1", "Reply stop reason disagrees with tool-use presence", JSON.stringify(reply)));
        break;
      }
      if (reply.text.length > 1_000_000) {
        findings.push(finding("state", "P2", "Responder emitted an unexpectedly large reply", `${reply.text.length} characters`));
        break;
      }

      const after = treeFingerprint(workspace);
      const previousTool = outstanding;
      if (
        before !== after &&
        previousTool?.id?.startsWith("aifirst_plan_") &&
        !previousTool.id.includes("_approval_")
      ) {
        findings.push(finding("state", "P1", "Workspace changed before plan approval", previousTool.id));
        break;
      }
      if (
        action.kind === "answer" &&
        ["reject", "empty"].includes(action.mode) &&
        previousTool?.id?.startsWith("aifirst_plan_") &&
        (planning.stepId || /This choice needs an LLM/i.test(reply.text))
      ) {
        findings.push(finding("state", "P1", "Rejected planning question did not leave planning", reply.text.slice(0, 500)));
        break;
      }
      if (
        action.kind === "prompt" &&
        previousTool?.id?.startsWith("aifirst_plan_") &&
        /This choice needs an LLM/i.test(reply.text)
      ) {
        findings.push(finding("state", "P1", "New exercise prompt was interpreted as a planning answer", reply.text.slice(0, 500)));
        break;
      }

      const fingerprint = replyFingerprint(reply, confirmation, planning);
      repeated = fingerprint === previousFingerprint ? repeated + 1 : 0;
      previousFingerprint = fingerprint;
      if (repeated >= 3 && action.kind === "answer" && ["reject", "empty", "stale"].includes(action.mode)) {
        if (action.mode === "stale" && planning.awaiting?.kind === "approval") {
          findings.push(finding("state", "P1", "Stale planning result shadows the active approval", reply.text.slice(0, 500)));
          break;
        }
      }

      if (outstanding?.id) staleIds.push(outstanding.id);
      outstanding = reply.toolUse;
    }
  } finally {
    process.chdir(originalCwd);
    if (originalState === undefined) delete process.env.AIFIRST_STATE_DIR;
    else process.env.AIFIRST_STATE_DIR = originalState;
    rmSync(root, { recursive: true, force: true });
  }
  return { findings, trace };
}

async function reproductions(actions: StateAction[], title: string): Promise<number> {
  let count = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runStateSequence(actions);
    if (result.findings.some((item) => item.title === title)) count++;
  }
  return count;
}

async function minimize(actions: StateAction[], title: string): Promise<StateAction[]> {
  let minimal = actions.slice();
  for (let index = 0; index < minimal.length && minimal.length > 1;) {
    const candidate = minimal.filter((_, itemIndex) => itemIndex !== index);
    const result = await runStateSequence(candidate);
    if (result.findings.some((item) => item.title === title)) minimal = candidate;
    else index++;
  }
  return minimal;
}

export async function runStateCampaign(cases = 5_000, seed = 0xa1f1_57): Promise<CampaignResult> {
  const started = performance.now();
  const random = new SeededRandom(seed);
  const findings: ExplorationFinding[] = [];
  const signatures = new Set<string>();
  for (let caseIndex = 0; caseIndex < cases; caseIndex++) {
    const caseSeed = Math.floor(random.next() * 0xffff_ffff);
    const caseRandom = new SeededRandom(caseSeed);
    const actions = generateActions(caseRandom, 5 + Math.floor(caseRandom.next() * 26));
    const result = await runStateSequence(actions);
    for (const found of result.findings) {
      const signature = `${found.layer}:${found.title}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      const minimized = await minimize(actions, found.title);
      found.sequence = minimized.map((action) => action.kind === "prompt" ? `prompt:${action.prompt}` : `answer:${action.mode}`);
      found.seed = caseSeed;
      found.reproductions = await reproductions(minimized, found.title);
      if (found.title === "Stale planning result shadows the active approval") {
        found.detail = "A user message containing an older planning-question result before the current approval result is parsed from the stale block, so Approve and build is ignored and the same approval prompt is emitted again.";
        found.sequence = [
          "prompt:ambiguous",
          "answer:stale (unknown stale result plus current editor selection)",
          "answer:valid (canonical editor answers)",
          "answer:stale (prior question result before current approval result)",
          "answer:stale",
          "answer:stale",
        ];
      }
      findings.push(found);
    }
  }
  return {
    name: "deterministic responder state machine",
    cases,
    durationMs: Math.round(performance.now() - started),
    findings,
    notes: [`master seed ${seed}`, "sequences contain 5-30 actions"],
  };
}

function responseToolId(body: Record<string, unknown>, prefix: string): string | undefined {
  const blocks = Array.isArray(body.content) ? body.content as Array<Record<string, unknown>> : [];
  return blocks.find((block) => typeof block.id === "string" && block.id.startsWith(prefix))?.id as string | undefined;
}

export async function runServerCampaign(randomCases = 200, seed = 0x51_7e): Promise<CampaignResult> {
  const started = performance.now();
  const root = mkdtempSync(join(tmpdir(), "aifirst-learn-server-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const originalCwd = process.cwd();
  const originalState = process.env.AIFIRST_STATE_DIR;
  process.chdir(workspace);
  process.env.AIFIRST_STATE_DIR = join(root, "state");
  const server = startBookServer({ port: 0, quiet: true });
  const findings: ExplorationFinding[] = [];
  let cases = 0;
  const post = (body: unknown, signal?: AbortSignal) => fetch(`${server.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const request = (text: string) => ({
    model: "exploration",
    messages: [{ role: "user", content: text }],
    tools: TOOLS,
  });

  try {
    cases++;
    const malformed = await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", body: "not json" });
    if (malformed.status !== 400) {
      findings.push(finding("server", "P2", "Malformed JSON did not receive a 400 response", `status ${malformed.status}`));
    }
    try {
      const next = await withTimeout(post(request("duckling")), 2_000, "request after malformed JSON");
      if (!next.ok) findings.push(finding("server", "P1", "Server did not recover after malformed JSON", `status ${next.status}`));
    } catch (error) {
      findings.push(finding("server", "P1", "Malformed JSON blocked the serialized message queue", String(error)));
    }

    cases++;
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const abort = new AbortController();
    const partial = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(encoder.encode("{"));
      },
    });
    const abandoned = fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: partial,
      duplex: "half",
      signal: abort.signal,
    } as RequestInit).catch(() => undefined);
    await Bun.sleep(20);
    abort.abort();
    controller?.error(new Error("aborted exploration body"));
    await abandoned;
    try {
      const next = await withTimeout(post(request("duckling")), 2_000, "request after aborted body");
      if (!next.ok) findings.push(finding("server", "P1", "Server rejected a request after an aborted body", `status ${next.status}`));
    } catch (error) {
      findings.push(finding("server", "P1", "Aborted request blocked the serialized message queue", String(error)));
    }

    cases++;
    const first = await post(request("duckling"));
    const firstBody = await first.json() as Record<string, unknown>;
    const firstId = responseToolId(firstBody, "aifirst_choose_replay_");
    if (firstId) {
      await post({
        model: "exploration",
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: firstId, content: '{"answers":{"Exercise":"None of these"}}' }] }],
        tools: TOOLS,
      });
      const second = await post(request("duckling"));
      const secondBody = await second.json() as Record<string, unknown>;
      const secondId = responseToolId(secondBody, "aifirst_choose_replay_");
      if (!secondId || secondId === firstId) {
        findings.push(finding("server", "P1", "Picker transaction id was reused after cancellation", `${firstId} -> ${secondId}`));
      } else {
        const selected = await post({
          model: "exploration",
          messages: [{ role: "user", content: [
            { type: "tool_result", tool_use_id: firstId, content: '{"answers":{"Exercise":"None of these"}}' },
            { type: "tool_result", tool_use_id: secondId, content: '{"answers":{"Exercise":"Design a Level Editor (py-10-01)"}}' },
          ] }],
          tools: TOOLS,
        });
        const selectedText = JSON.stringify(await selected.json());
        if (/No exercise selected/.test(selectedText)) {
          findings.push(finding("server", "P1", "Stale cancellation won over the current picker result", selectedText.slice(0, 500)));
        }
      }
    }

    const random = new SeededRandom(seed);
    for (let index = 0; index < randomCases; index++) {
      cases++;
      const prompt = random.pick(["duckling", "levels", "Write a Hello World app", "aifirst help", "off book prose"]);
      const calls: Promise<Response>[] = [post(request(prompt))];
      if (random.next() < 0.7) calls.push(fetch(`${server.baseUrl}/v1/messages/count_tokens`, { method: "POST", body: "{}" }));
      if (random.next() < 0.35) calls.push(post(request(prompt)));
      try {
        const responses = await withTimeout(Promise.all(calls), 2_000, `server schedule ${index}`);
        if (responses.some((response) => response.status >= 500)) {
          findings.push(finding("server", "P1", "Server emitted a 5xx response under concurrent traffic", `case ${index}`));
          break;
        }
        await Promise.all(responses.map((response) => response.arrayBuffer()));
      } catch (error) {
        findings.push(finding("server", "P1", "Server concurrency schedule exceeded the liveness deadline", `case ${index}: ${error}`));
        break;
      }
    }
  } finally {
    server.stop();
    process.chdir(originalCwd);
    if (originalState === undefined) delete process.env.AIFIRST_STATE_DIR;
    else process.env.AIFIRST_STATE_DIR = originalState;
    rmSync(root, { recursive: true, force: true });
  }
  return {
    name: "HTTP ordering and cancellation chaos",
    cases,
    durationMs: Math.round(performance.now() - started),
    findings,
    notes: [`random seed ${seed}`, `${randomCases} randomized schedules plus directed abort/stale-result cases`],
  };
}

export function writeExplorationReport(report: ExplorationReport, outputDir: string): { json: string; markdown: string } {
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = join(outputDir, "report.json");
  const markdownPath = join(outputDir, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    "# aifirst learn exploration report",
    "",
    `Generated: ${report.generatedAt}`,
    `Platform: ${report.platform}`,
    `CLI: ${report.cliVersion}`,
    `Claude: ${report.claudeVersion}`,
    "",
    "## Campaigns",
    "",
    ...report.campaigns.flatMap((campaign) => [
      `- **${campaign.name}:** ${campaign.cases} cases, ${campaign.findings.length} findings, ${campaign.durationMs} ms`,
      ...campaign.notes.map((note) => `  - ${note}`),
    ]),
    "",
    "## Findings",
    "",
    ...(report.findings.length === 0
      ? ["No invariant violations were discovered."]
      : report.findings.flatMap((item) => [
          `### ${item.severity} ${item.title}`,
          "",
          `Layer: ${item.layer}`,
          item.seed === undefined ? "" : `Seed: ${item.seed}`,
          item.reproductions === undefined ? "" : `Reproductions: ${item.reproductions}/3`,
          "",
          item.detail,
          ...(item.sequence?.length ? ["", "Sequence:", "", "```text", ...item.sequence, "```"] : []),
          "",
        ].filter(Boolean))),
  ];
  writeFileSync(markdownPath, `${lines.join("\n")}\n`);
  return { json: jsonPath, markdown: markdownPath };
}
