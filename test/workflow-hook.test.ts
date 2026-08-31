import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("skill-mode planning hook", () => {
  test("returns planning context without executing the replay", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-workflow-hook-"));
    const input = JSON.stringify({
      prompt: "Make a game about a baby duckling who is trying to find its mother using pygame.",
      cwd: root,
    });
    const proc = Bun.spawn([process.execPath, "run", ENTRY, "replay", "hook"], {
      cwd: root,
      env: { ...process.env, AIFIRST_STATE_DIR: join(root, "state") },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(input);
    proc.stdin.end();
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode, stderr).toBe(0);

    const result = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
    const context = result.hookSpecificOutput.additionalContext;
    const payloadStart = context.lastIndexOf('\n\n{\n  "exerciseId"') + 2;
    const payload = JSON.parse(context.slice(payloadStart)) as {
      questionSteps: Array<{
        kind: string;
        group?: string;
        questions?: Array<{ id: string; options: Array<{ id: string; label: string }> }>;
        question?: { id: string; when?: Record<string, string>; options: Array<{ id: string; label: string }> };
      }>;
    };
    expect(context).toContain("Enter Claude Code native plan mode");
    expect(payload.questionSteps).toHaveLength(2);
    expect(payload.questionSteps[0].kind).toBe("group");
    expect(payload.questionSteps[0].group).toBe("group_1");
    expect(payload.questionSteps[0].questions?.map((question) => question.id)).toEqual(["game_style", "challenge", "art_style"]);
    expect(payload.questionSteps[0].questions?.find((question) => question.id === "challenge")?.options.map((option) => option.id)).toEqual([
      "avoid_predators", "collect_siblings", "timer_limited_energy", "just_exploration",
    ]);
    expect(payload.questionSteps[0].questions?.find((question) => question.id === "challenge")?.options[1].label).toBe("Collect siblings (Book Recommended)");
    expect(payload.questionSteps[1]).toEqual({
      kind: "question",
      question: expect.objectContaining({
        id: "sprite_source",
        when: {
          game_style: "top_down_maze_exploration",
          challenge: "collect_siblings",
          art_style: "simple_sprite_images",
        },
      }),
    });
    expect(context).toContain('"canonicalPlan"');
    expect(context).toContain('"canonicalReplay"');
    expect(context).toContain("aifirst replay execute py-9-01 --format json");
    expect(context).not.toContain('"operations"');
    expect(context.length).toBeLessThan(15_000);
    expect(Math.max(...context.split("\n").map((line) => line.length))).toBeLessThan(8_000);
    expect(context).toContain(`current working directory (${root})`);
    expect(context).not.toContain("C:\\Users\\cassandra");
    expect(context).not.toContain("savetheduckling/");
    expect(context).toContain("--variant-json");
    expect(existsSync(join(root, "main.py"))).toBe(false);
    expect(existsSync(join(root, "constants.py"))).toBe(false);
  });
});
