/**
 * Real Claude Code regression for fuzzy replay confirmation.
 *
 * Unit tests cannot reproduce Claude's full message history, session metadata,
 * or actual built-in tool list. This starts the installed Claude binary twice:
 * once for the fuzzy prompt, then again with --resume for the confirmation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBookServer } from "../src/commands/serve";
import { resolveContent } from "../src/content";
import { SERVER_TOOLS } from "../src/learn/session";
import { seedScaffold } from "./helpers/scaffold";

const claude = Bun.which("claude");
const liveEnabled = process.env.AIFIRST_CLAUDE_LIVE === "1";
const describeLive = liveEnabled && claude ? describe : describe.skip;
const pythonReady = Bun.spawnSync({
  cmd: ["python3", "-c", "import PIL, pygame"],
  env: { ...process.env, PYGAME_HIDE_SUPPORT_PROMPT: "1" },
}).exitCode === 0;
const testGameLive = liveEnabled && claude && pythonReady ? test : test.skip;

if (!liveEnabled || !claude) {
  console.warn("learn-confirmation-live: set AIFIRST_CLAUDE_LIVE=1 with `claude` on PATH to run real-client confirmation tests.");
}

describeLive("live fuzzy confirmation (real Claude Code client)", () => {
  let root = "";
  const originalState = process.env.AIFIRST_STATE_DIR;

  afterEach(() => {
    if (originalState === undefined) delete process.env.AIFIRST_STATE_DIR;
    else process.env.AIFIRST_STATE_DIR = originalState;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("resuming with yes runs the replay that was displayed", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-live-confirmation-"));
    const home = join(root, "home");
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    const settings = join(root, "settings.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(*)", "Edit(*)", "Read(*)", "Write(*)"] } }) + "\n", { mode: 0o600 });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [workspace]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }) + "\n", { mode: 0o600 });
    process.env.AIFIRST_STATE_DIR = state;
    const originalCwd = process.cwd();
    process.chdir(workspace);

    const advertisedTools = new Set<string>();
    const exchanges: string[] = [];
    const toolResults: string[] = [];
    const server = startBookServer({
      port: 0,
      quiet: true,
      onRequest: (request) => {
        for (const tool of request.tools ?? []) if (tool.name) advertisedTools.add(tool.name);
        const last = request.messages?.at(-1);
        if (last && Array.isArray(last.content)) {
          for (const block of last.content) {
            if (block.type === "tool_result") toolResults.push(JSON.stringify(block));
          }
        }
      },
      onReply: (reply, pending) => exchanges.push(`${reply.exerciseId ?? "-"}:${reply.stopReason}:${pending ?? "-"}`),
    });
    const sessionId = crypto.randomUUID();
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      AIFIRST_STATE_DIR: state,
      ANTHROPIC_BASE_URL: server.baseUrl,
      ANTHROPIC_AUTH_TOKEN: "synthetic-live-confirmation",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_LOGIN_COMMAND: "1",
    };

    const run = async (args: string[]) => {
      const proc = Bun.spawn([claude as string, "--setting-sources", "user", "--settings", settings, "--tools", SERVER_TOOLS, ...args], {
        cwd: workspace,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-8000)}`).toBe(0);
      return stdout.trim();
    };

    try {
      const first = await run(["--session-id", sessionId, "-p", "build a hello world"]);
      expect(first).toContain("Write Hello World app");

      const second = await run(["--resume", sessionId, "-p", "yes"]);
      console.warn(`learn-confirmation-live: exchanges: ${exchanges.join(", ")}`);
      console.warn(`learn-confirmation-live: Claude advertised tools: ${[...advertisedTools].sort().join(", ")}`);
      console.warn(`learn-confirmation-live: tool results: ${toolResults.join(" | ")}`);
      expect(second).not.toContain("confirmation is no longer available");
      expect(second).not.toContain("If/Else with Booleans");
      expect(second).toMatch(/(?:Replay completed|Hello, World!|hello\.py)/);

      // This records the actual client capability rather than assuming that
      // --tools default necessarily includes the interactive question tool.
    } finally {
      server.stop();
      process.chdir(originalCwd);
    }
  }, 30_000);

  test("interactive Claude renders and accepts the native replay choice", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-live-choice-"));
    const home = join(root, "home");
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    const settings = join(root, "settings.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(*)", "Edit(*)", "Read(*)", "Write(*)"] } }) + "\n", { mode: 0o600 });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [workspace]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }) + "\n", { mode: 0o600 });
    process.env.AIFIRST_STATE_DIR = state;
    const originalCwd = process.cwd();
    process.chdir(workspace);

    const advertisedTools = new Set<string>();
    const server = startBookServer({
      port: 0,
      quiet: true,
      onRequest: (request) => {
        for (const tool of request.tools ?? []) if (tool.name) advertisedTools.add(tool.name);
      },
    });
    const driver = join(import.meta.dir, "fixtures", "claude-choice-driver.py");
    try {
      const proc = Bun.spawn(["python3", driver, claude as string, settings, workspace], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TERM: "xterm-256color",
          AIFIRST_STATE_DIR: state,
          ANTHROPIC_BASE_URL: server.baseUrl,
          ANTHROPIC_AUTH_TOKEN: "synthetic-live-choice",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_LOGIN_COMMAND: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-8000)}`).toBe(0);
      expect(advertisedTools.has("AskUserQuestion")).toBe(true);
      expect(stdout).toContain("Run this replay");
      expect(stdout).not.toContain("isn't a prompt from the book");
    } finally {
      server.stop();
      process.chdir(originalCwd);
    }
  }, 30_000);

  testGameLive("interactive Claude resumes the fox replay after native confirmation", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-live-fox-choice-"));
    const home = join(root, "home");
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    const settings = join(root, "settings.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const content = resolveContent().content;
    const base = content.steps.find((step) => step.id === "py-9-01")!;
    seedScaffold(workspace, base, content);
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(*)", "Edit(*)", "Read(*)", "Write(*)"] } }) + "\n", { mode: 0o600 });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [workspace]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }) + "\n", { mode: 0o600 });
    process.env.AIFIRST_STATE_DIR = state;
    const originalCwd = process.cwd();
    process.chdir(workspace);

    const requests: string[] = [];
    const server = startBookServer({
      port: 0,
      quiet: true,
      onRequest: (request) => requests.push(JSON.stringify(request.messages?.at(-1) ?? null)),
    });
    const driver = join(import.meta.dir, "fixtures", "claude-choice-driver.py");
    try {
      const proc = Bun.spawn(["python3", driver, claude as string, settings, workspace, "fox"], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TERM: "xterm-256color",
          AIFIRST_STATE_DIR: state,
          ANTHROPIC_BASE_URL: server.baseUrl,
          ANTHROPIC_AUTH_TOKEN: "synthetic-live-fox-choice",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_LOGIN_COMMAND: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-8000)}\nRequests:\n${requests.join("\n")}`).toBe(0);
      expect(stdout).toContain("Run this replay");
      expect(existsSync(join(workspace, "main.py"))).toBe(true);
      expect(existsSync(join(workspace, "assets", "fox.png"))).toBe(true);
    } finally {
      server.stop();
      process.chdir(originalCwd);
    }
  }, 45_000);

  test("interactive Claude offers ambiguous exercises and honors None of these", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-live-ambiguous-choice-"));
    const home = join(root, "home");
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    const settings = join(root, "settings.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(*)", "Edit(*)", "Read(*)", "Write(*)"] } }) + "\n", { mode: 0o600 });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [workspace]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }) + "\n", { mode: 0o600 });
    process.env.AIFIRST_STATE_DIR = state;
    const originalCwd = process.cwd();
    process.chdir(workspace);

    const server = startBookServer({ port: 0, quiet: true });
    const driver = join(import.meta.dir, "fixtures", "claude-ambiguous-choice-driver.py");
    const compactTui = (value: string) => value
      .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, "")
      .replace(/\s+/g, "");
    const run = async (mode: "none" | "select") => {
      const proc = Bun.spawn(["python3", driver, claude as string, settings, workspace, mode], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TERM: "xterm-256color",
          AIFIRST_STATE_DIR: state,
          ANTHROPIC_BASE_URL: server.baseUrl,
          ANTHROPIC_AUTH_TOKEN: "synthetic-live-ambiguous-choice",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_LOGIN_COMMAND: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-8000)}`).toBe(0);
      return stdout;
    };

    try {
      const declined = await run("none");
      expect(compactTui(declined)).toContain("Noneofthese");
      expect(compactTui(declined)).toContain("Nothingwaschangedorrecorded");
      expect(existsSync(join(workspace, "main.py"))).toBe(false);

      const content = resolveContent().content;
      const fox = content.steps.find((step) => step.id === "py-9-02")!;
      seedScaffold(workspace, fox, content);
      const selected = await run("select");
      expect(compactTui(selected)).toContain("AddTwoHarderLevels");
      expect(compactTui(selected)).toContain("Howshouldthegametransitionbetweenlevels?");
      const foxMain = fox.scaffold?.files.find((file) => file.path === "main.py")?.content;
      expect(foxMain).toBeDefined();
      expect(readFileSync(join(workspace, "main.py"), "utf8")).toBe(foxMain!);
    } finally {
      server.stop();
      process.chdir(originalCwd);
    }
  }, 45_000);
});
