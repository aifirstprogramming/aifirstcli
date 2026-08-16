/**
 * Live interactive regression for book-mode chat command routing.
 *
 * A unit test on `parseChatCommand` alone cannot catch this bug class: the
 * broken behaviour lived one layer up, in whether Claude Code's own
 * slash-command interception ever lets a typed string reach the HTTP request
 * this module inspects. This drives a real `claude --bare` process against a
 * real `aifirst serve` instance, the same launch shape `aifirst learn` uses.
 *
 * Skipped, loudly, when no `claude` binary is on PATH. Never silently
 * downgrading to a stubbed client, which is the exact failure mode that let
 * this bug ship with green tests in the first place.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBookServer, type BookServer } from "../src/commands/serve";
import { mark } from "../src/log/progress";

const claudeBin = Bun.which("claude");
const describeLive = claudeBin ? describe : describe.skip;

if (!claudeBin) {
  console.warn(
    "learn-interactive-regression: no `claude` binary on PATH -- skipping the live " +
      "harness. This environment cannot verify book-mode chat routing against a real client.",
  );
}

describeLive("live book-mode chat routing (real claude --bare client)", () => {
  let server: BookServer;
  let root: string;
  let progressPath: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "aifirst-interactive-"));
    progressPath = join(root, "progress.json");
    mark("py-1-01", { path: progressPath, via: "run" });
    process.env.AIFIRST_STATE_DIR = root;
    server = startBookServer({ port: 0, quiet: true });
  });

  afterAll(() => {
    server.stop();
    delete process.env.AIFIRST_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  /** One `claude --bare -p <prompt>` round trip, isolated from any real profile. */
  async function ask(prompt: string): Promise<string> {
    const home = mkdtempSync(join(tmpdir(), "aifirst-claude-home-"));
    const settings = join(home, "settings.json");
    writeFileSync(settings, "{}\n");
    try {
      const proc = Bun.spawn(["claude", "--bare", "--settings", settings, "-p", prompt], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          IS_DEMO: "1",
          ANTHROPIC_BASE_URL: server.baseUrl,
          ANTHROPIC_AUTH_TOKEN: "synthetic-interactive-test",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_LOGIN_COMMAND: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout] = await Promise.all([new Response(proc.stdout).text()]);
      await proc.exited;
      return stdout.trim();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("aifirst next (no slash) returns the next-exercise reply, not a refusal", async () => {
    const reply = await ask("aifirst next");
    expect(reply).toMatch(/(?:```(?:python|java)|aifirst run (?:py|java)-[0-9-]+|Approve it)/);
    expect(reply.toLowerCase()).not.toContain("isn't a prompt from the book");
    expect(reply.toLowerCase()).not.toContain("local learning accepts only a complete safe");
  }, 20_000);

  test("aifirst show <id> (no slash) renders Code before Explanation", async () => {
    const reply = await ask("aifirst show py-1-01");
    expect(reply).toContain('print("Hello, World!")');
  }, 20_000);

  test("aifirst progress (no slash) renders the ledger acknowledgement", async () => {
    const reply = await ask("aifirst progress");
    expect(reply).toContain("local learning accepts `aifirst progress`");
  }, 20_000);

  test("aifirst done <id> (no slash) is acknowledged as a safe command", async () => {
    const reply = await ask("aifirst done py-1-01");
    expect(reply).toContain("local learning accepts `aifirst done`");
  }, 20_000);

  test("/aifirst next (with a leading slash) never reaches book mode", async () => {
    // Documents the platform boundary this fix works around: Claude Code's own
    // slash-command layer answers "Unknown command" client-side. No registered
    // command spells the space-separated `/aifirst next` form, so no request
    // for it ever leaves the client -- book mode cannot see it, let alone
    // answer it. This is why the help text no longer promises this form.
    const reply = await ask("/aifirst next");
    expect(reply).toContain("Unknown command");
  }, 20_000);

  test("a withheld command still refuses in chat, live", async () => {
    const reply = await ask("aifirst reset --all");
    expect(reply).toContain("local learning accepts only a complete safe");
  }, 20_000);

  test("prose embedding a command is still refused, live", async () => {
    // chatReply treats any text containing the word "aifirst" that fails to
    // parse as a clean command as an error rather than a book-prompt refusal
    // (responder.ts's chatReply / chatCommandError branch). Still a refusal,
    // just a different one than off-book prose with no "aifirst" in it at all.
    const reply = await ask("please /aifirst next tell me what to do");
    expect(reply).toContain("local learning accepts only a complete safe");
  }, 20_000);
});
