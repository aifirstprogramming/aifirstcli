/**
 * End-to-end regression for the chapter 9 duckling replay through real Claude Code.
 *
 * The authoritative v2 reports come from the original authoring session. The
 * local responder adds book envelopes and native-tool formatting, but every
 * captured assistant block and operation must survive exactly and in order.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveContent } from "../src/content";
import type { ReplayStep } from "../src/content/types";
import { expectScaffold, seedScaffold } from "./helpers/scaffold";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const claude = Bun.which("claude");
const pythonReady = Bun.spawnSync({
  cmd: ["python3", "-c", "import PIL, pygame"],
  env: { ...process.env, PYGAME_HIDE_SUPPORT_PROMPT: "1" },
}).exitCode === 0;
const liveEnabled = process.env.AIFIRST_CLAUDE_LIVE === "1";
const describeLive = liveEnabled && claude && pythonReady ? describe : describe.skip;
const content = resolveContent().content;

if (!liveEnabled || !claude || !pythonReady) {
  const missing = [!liveEnabled && "AIFIRST_CLAUDE_LIVE=1", !claude && "Claude Code", !pythonReady && "pygame/Pillow"].filter(Boolean).join(" and ");
  console.warn(`duckling-learn-live: ${missing} unavailable; skipping the real aifirst learn replay.`);
}

interface StreamBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | StreamBlock[];
}

interface StreamEvent {
  type?: string;
  message?: { content?: StreamBlock[] };
}

function renderedTranscript(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_result" && typeof block.content === "string") parts.push(block.content);
      }
      continue;
    }
    if (event.type !== "assistant") continue;
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text) parts.push(block.text);
      if (block.type === "tool_use" && block.name) {
        const target = typeof block.input?.file_path === "string" ? basename(block.input.file_path) : "";
        const detail = typeof block.input?.content === "string"
          ? block.input.content
          : typeof block.input?.command === "string"
            ? block.input.command
            : "";
        parts.push(`${block.name}${target ? `(${target})` : ""}${detail ? `\n${detail}` : ""}`);
      }
    }
  }
  return parts.join("\n\n");
}

function planningQuestions(stdout: string): string[] {
  const questions: string[] = [];
  const add = (question: string) => {
    if (!questions.includes(question)) questions.push(question);
  };
  const authoredQuestions = [
    "How should the game transition between levels?",
    "How should difficulty ramp up across the 3 levels, beyond just more obstacles/foxes?",
    "Should the number of siblings to collect also increase in later levels?",
  ];
  for (const line of stdout.split(/\r?\n/)) {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text) {
        for (const question of authoredQuestions) if (block.text.includes(question)) add(question);
        if (block.text.includes("## Proposed plan") && block.text.includes("Approve and build")) {
          add("Approve this plan?");
        }
      }
      if (block.type !== "tool_use" || block.name?.toLowerCase() !== "askuserquestion") continue;
      const inputQuestions = block.input?.questions;
      if (!Array.isArray(inputQuestions)) continue;
      for (const question of inputQuestions) {
        if (question && typeof question === "object" && typeof question.question === "string") {
          add(question.question);
        }
      }
    }
  }
  return questions;
}

function transcriptWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/c:\\users\\cassandra\\savetheduckling/gi, " workspace ")
    .replace(/\/tmp\/[a-z0-9._/-]+/gi, " workspace ")
    .replace(/\b\d+(?:\.\d+){1,3}\b/g, " version ")
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3);
}

function orderedReferenceCoverage(actual: string, reference: string): number {
  const actualWords = transcriptWords(actual);
  const referenceWords = transcriptWords(reference);
  let previous = new Uint16Array(actualWords.length + 1);
  for (const referenceWord of referenceWords) {
    const current = new Uint16Array(actualWords.length + 1);
    for (let index = 1; index <= actualWords.length; index++) {
      current[index] = referenceWord === actualWords[index - 1]
        ? previous[index - 1] + 1
        : Math.max(previous[index], current[index - 1]);
    }
    previous = current;
  }
  return previous[actualWords.length] / referenceWords.length;
}

function assistantTranscript(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as StreamEvent;
      if (event.type !== "assistant") continue;
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text) parts.push(block.text);
      }
    } catch {
      // Ignore non-stream diagnostics.
    }
  }
  return parts.join("\n\n");
}

function expectInOrder(actual: string, anchors: string[]): void {
  let cursor = 0;
  for (const anchor of anchors) {
    const found = actual.indexOf(anchor, cursor);
    expect(found, `Missing or out-of-order transcript anchor: ${anchor}`).toBeGreaterThanOrEqual(0);
    cursor = found + anchor.length;
  }
}

function seedWorkspace(workspace: string, stepId: string): void {
  const step = content.steps.find(
    (candidate) => candidate.id === stepId,
  )! as ReplayStep;
  seedScaffold(workspace, step, content);
}

function showtailReferenceOutputs(stepId: string): string[] {
  const contentRoot = process.env.AIFIRST_CONTENT_REPO ?? join(import.meta.dir, "..", "..", "aifirstcontent");
  const report = JSON.parse(readFileSync(join(
    contentRoot,
    "replays",
    "python",
    "chapter-09",
    stepId,
    "bundle",
    "report.json",
  ), "utf8")) as { turns: Array<{ aiOutputs?: Array<{ text: string }> }> };
  return (report.turns[0]?.aiOutputs ?? []).map((output) => output.text);
}

function showtailReference(stepId: string): string {
  return showtailReferenceOutputs(stepId).join("\n\n");
}

function expectCapturedAssistantBlocks(stdout: string, stepId: string): void {
  const actual: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as StreamEvent;
      if (event.type !== "assistant") continue;
      for (const block of event.message?.content ?? [])
        if (block.type === "text" && block.text)
          actual.push(block.text.replace(/\r\n/g, "\n"));
    } catch {
      // Ignore non-stream diagnostics.
    }
  }
  let blockIndex = 0;
  let blockOffset = 0;
  for (const expected of showtailReferenceOutputs(stepId)) {
    const normalized = expected.replace(/\r\n/g, "\n");
    let foundBlock = -1;
    let foundOffset = -1;
    for (let index = blockIndex; index < actual.length; index++) {
      const offset = actual[index].indexOf(
        normalized,
        index === blockIndex ? blockOffset : 0,
      );
      if (offset < 0) continue;
      foundBlock = index;
      foundOffset = offset;
      break;
    }
    expect(foundBlock, `Missing exact ${stepId} assistant text: ${normalized.slice(0, 120)}`).toBeGreaterThanOrEqual(0);
    blockIndex = foundBlock;
    blockOffset = foundOffset + normalized.length;
  }
}

function nativeOperationCounts(stdout: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of stdout.split(/\r?\n/)) {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (event.type !== "assistant") continue;
    for (const block of event.message?.content ?? []) {
      if (block.type !== "tool_use" || !block.name) continue;
      const type = ({ bash: "command", write: "write", edit: "edit", read: "read" } as Record<string, string>)[block.name.toLowerCase()];
      if (type) counts[type] = (counts[type] ?? 0) + 1;
    }
  }
  return counts;
}

function replayOperationCounts(stepId: string): Record<string, number> {
  const step = resolveContent().content.steps.find(
    (candidate) => candidate.id === stepId,
  )! as ReplayStep;
  const allEvents = [
    ...(step.replay?.prePlanEvents ?? []),
    ...(step.replay?.workflow?.interludes ?? []).flatMap((interlude) => interlude.events),
    ...(step.replay?.events ?? []),
  ];
  const counts: Record<string, number> = {};
  for (const event of allEvents) {
    if (event.type !== "operation") continue;
    counts[event.operation.type] = (counts[event.operation.type] ?? 0) + 1;
  }
  return counts;
}

function expectOperationCounts(stdout: string, stepId: string): void {
  const expected = replayOperationCounts(stepId);
  const actual = nativeOperationCounts(stdout);
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    expect(actual[key] ?? 0, `${stepId} ${key} operation count`).toBe(expected[key] ?? 0);
  }
}

describeLive("chapter 9 duckling replay through aifirst learn", () => {
  let root = "";
  const originalState = process.env.AIFIRST_STATE_DIR;

  afterEach(() => {
    if (originalState === undefined) delete process.env.AIFIRST_STATE_DIR;
    else process.env.AIFIRST_STATE_DIR = originalState;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("reconstructs the game and exactly preserves the captured Claude text", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-duckling-live-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    process.env.AIFIRST_STATE_DIR = state;

    const driver = join(import.meta.dir, "fixtures", "duckling-stream-driver.py");
    const proc = Bun.spawn(["python3", driver, process.execPath, ENTRY, workspace, "canonical"], {
      cwd: workspace,
      env: { ...process.env, AIFIRST_STATE_DIR: state, AIFIRST_LEARN_CHARS_PER_SECOND: "100000" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);

    const transcript = renderedTranscript(stdout);
    const assistant = assistantTranscript(stdout);
    const reference = showtailReference("py-9-01");
    const coverage = orderedReferenceCoverage(assistant, reference);
    console.warn(`duckling-learn-live: ordered reference coverage ${(coverage * 100).toFixed(1)}%`);
    expect(coverage, `Ordered Claude transcript coverage was ${(coverage * 100).toFixed(1)}%\n${assistant.slice(-8000)}`).toBe(1);
    expectCapturedAssistantBlocks(stdout, "py-9-01");
    expectInOrder(assistant, ["Good — Python 3.11.9", "Pillow is available too", "I've kicked off the design planning agent", "## Proposed plan", "Now I'll implement the plan", "Found a bug", "The core logic", "The game is complete and working"]);
    expectOperationCounts(stdout, "py-9-01");
    expect(transcript).toContain("Found a bug");
    expect(transcript).toContain("The core logic (movement, collision, collecting siblings, win condition) checks out.");
    expect(transcript).toContain("The game is complete and working");
    expect(transcript).not.toContain("## Planning");
    expect(transcript).not.toContain("## Claude Code Replay (continued)");

    const step = content.steps.find((candidate) => candidate.id === "py-9-01")!;
    expectScaffold(workspace, step, content);
    for (const asset of [
      "duckling.png", "mother_duck.png", "sibling_1.png", "sibling_2.png", "sibling_3.png",
      "grass_tile.png", "water_tile.png", "rock.png", "bush.png",
    ]) {
      expect(existsSync(join(workspace, "assets", asset)), asset).toBe(true);
    }
    expect(existsSync(join(workspace, "screenshot.png"))).toBe(false);
  }, 60_000);

  test("adds fox enemies and exactly preserves the captured Claude text", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-duckling-fox-live-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    seedWorkspace(workspace, "py-9-01");
    process.env.AIFIRST_STATE_DIR = state;

    const driver = join(import.meta.dir, "fixtures", "duckling-stream-driver.py");
    const proc = Bun.spawn(["python3", driver, process.execPath, ENTRY, workspace, "fox"], {
      cwd: workspace,
      env: { ...process.env, AIFIRST_STATE_DIR: state, AIFIRST_LEARN_CHARS_PER_SECOND: "100000" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);

    const transcript = renderedTranscript(stdout);
    const assistant = assistantTranscript(stdout);
    const reference = showtailReference("py-9-02");
    const coverage = orderedReferenceCoverage(assistant, reference);
    console.warn(`duckling-fox-live: ordered reference coverage ${(coverage * 100).toFixed(1)}%`);
    expect(coverage, `Ordered Claude transcript coverage was ${(coverage * 100).toFixed(1)}%\n${assistant.slice(-8000)}`).toBe(1);
    expectCapturedAssistantBlocks(stdout, "py-9-02");
    expectInOrder(assistant, ["Now let's regenerate and preview the fox sprite", "That reads clearly as a fox", "Now let's wire foxes", "Fox patrol and catch logic work correctly", "Added two foxes"]);
    expect(transcript).not.toContain("## Planning");
    expect(transcript).toContain("Added two foxes");
    expect(transcript).not.toContain("## Claude Code Replay (continued)");
    expectOperationCounts(stdout, "py-9-02");

    const step = content.steps.find((candidate) => candidate.id === "py-9-02")!;
    expectScaffold(workspace, step, content);
    expect(existsSync(join(workspace, "assets", "fox.png"))).toBe(true);
    expect(existsSync(join(workspace, "screenshot.png"))).toBe(false);
  }, 60_000);

  test("plans and builds two harder levels from the captured book choices", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-duckling-levels-live-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    seedWorkspace(workspace, "py-9-02");
    process.env.AIFIRST_STATE_DIR = state;

    const driver = join(import.meta.dir, "fixtures", "duckling-stream-driver.py");
    const proc = Bun.spawn(["python3", driver, process.execPath, ENTRY, workspace, "levels"], {
      cwd: workspace,
      env: { ...process.env, AIFIRST_STATE_DIR: state, AIFIRST_LEARN_CHARS_PER_SECOND: "100000" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);

    expect(planningQuestions(stdout)).toEqual([
      "How should the game transition between levels?",
      "How should difficulty ramp up across the 3 levels, beyond just more obstacles/foxes?",
      "Should the number of siblings to collect also increase in later levels?",
      "Approve this plan?",
    ]);
    const transcript = renderedTranscript(stdout);
    const assistant = assistantTranscript(stdout);
    const reference = showtailReference("py-9-03");
    const coverage = orderedReferenceCoverage(assistant, reference);
    console.warn(`duckling-levels-live: ordered reference coverage ${(coverage * 100).toFixed(1)}%`);
    expect(coverage, `Ordered Claude transcript coverage was ${(coverage * 100).toFixed(1)}%\n${assistant.slice(-8000)}`).toBe(1);
    expectCapturedAssistantBlocks(stdout, "py-9-03");
    expectInOrder(assistant, ["How should the game transition", "The design agent is working", "Let me verify the proposed level 2/3 layouts", "Both maps are fully connected", "## Proposed plan", "Now implementing", "The full progression works exactly as designed", "The game now has three levels"]);
    expectOperationCounts(stdout, "py-9-03");
    expect(transcript.indexOf("## Proposed plan")).toBeLessThan(transcript.indexOf("Edit(constants.py)"));
    expect(transcript).toContain("## Proposed plan");
    expect(transcript).toContain("The game now has three levels of increasing difficulty");
    expect(transcript).not.toContain("## Claude Code Replay (continued)");

    const step = content.steps.find((candidate) => candidate.id === "py-9-03")!;
    expectScaffold(workspace, step, content);
    expect(existsSync(join(workspace, "assets", "fox.png"))).toBe(true);
    for (let index = 1; index <= 3; index++) {
      expect(existsSync(join(workspace, `screenshot_level${index}.png`))).toBe(false);
    }
  }, 60_000);

  test("guides an unsupported choice back to the book path", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-duckling-fallback-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const driver = join(import.meta.dir, "fixtures", "duckling-stream-driver.py");
    const proc = Bun.spawn(["python3", driver, process.execPath, ENTRY, workspace, "fallback"], {
      cwd: workspace,
      env: { ...process.env, AIFIRST_STATE_DIR: state, AIFIRST_LEARN_CHARS_PER_SECOND: "100000" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
    const transcript = renderedTranscript(stdout);
    expect(transcript).toContain("This choice needs an LLM");
    expect(transcript).toContain("Use book-recommended answer");
    expect(transcript).toContain("The game is complete and working");
    expect(existsSync(join(workspace, "main.py"))).toBe(true);
  }, 60_000);

  test("confirms a fuzzy duckling prompt before starting planning", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-duckling-fuzzy-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const driver = join(import.meta.dir, "fixtures", "duckling-stream-driver.py");
    const proc = Bun.spawn(["python3", driver, process.execPath, ENTRY, workspace, "fuzzy"], {
      cwd: workspace,
      env: { ...process.env, AIFIRST_STATE_DIR: state, AIFIRST_LEARN_CHARS_PER_SECOND: "100000" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
    const transcript = renderedTranscript(stdout);
    expect(transcript).toContain("A replay may match this prompt");
    expect(transcript.indexOf("A replay may match this prompt")).toBeLessThan(transcript.indexOf("What style of gameplay"));
    expect(transcript).not.toContain("## Planning");
    expect(transcript).toContain("The game is complete and working");
  }, 60_000);

  test("renders the canonical workflow through Claude Code's native question UI", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-duckling-tui-"));
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const driver = join(import.meta.dir, "fixtures", "duckling-plan-driver.py");
    const proc = Bun.spawn(["python3", driver, process.execPath, ENTRY, workspace], {
      cwd: workspace,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        AIFIRST_STATE_DIR: state,
        AIFIRST_LEARN_CHARS_PER_SECOND: "100000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
    expect(stdout).toContain("Book Recommended");
    expect(stdout).toContain("User answered Claude's questions");
    expect(existsSync(join(workspace, "main.py"))).toBe(true);
  }, 60_000);
});
