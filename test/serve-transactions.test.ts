import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBookServer } from "../src/commands/serve";

const TOOLS = [
  { name: "AskUserQuestion", input_schema: { properties: { questions: { type: "array" } } } },
  { name: "Read", input_schema: { properties: { file_path: { type: "string" } } } },
  { name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } } } },
  { name: "Edit", input_schema: { properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } } } },
  { name: "Bash", input_schema: { properties: { command: { type: "string" } } } },
];

interface MessageBody {
  content: Array<{ type?: string; id?: string; name?: string; text?: string }>;
  stop_reason: string;
}

function tool(body: MessageBody, prefix: string) {
  return body.content.find((block) => block.type === "tool_use" && block.id?.startsWith(prefix));
}

async function withServer(run: (post: (content: unknown) => Promise<MessageBody>) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aifirst-server-transactions-"));
  const workspace = join(root, "workspace");
  const originalCwd = process.cwd();
  const originalState = process.env.AIFIRST_STATE_DIR;
  mkdirSync(workspace);
  process.chdir(workspace);
  process.env.AIFIRST_STATE_DIR = join(root, "state");
  const server = startBookServer({ port: 0, quiet: true });
  const post = async (content: unknown) => {
    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5",
        messages: [{ role: "user", content }],
        tools: TOOLS,
      }),
    });
    expect(response.status).toBe(200);
    return await response.json() as MessageBody;
  };
  try {
    await run(post);
  } finally {
    server.stop();
    process.chdir(originalCwd);
    if (originalState === undefined) delete process.env.AIFIRST_STATE_DIR;
    else process.env.AIFIRST_STATE_DIR = originalState;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("server-owned interactive transactions", () => {
  test("ignores a stale fuzzy cancellation and keeps the current confirmation id", async () => {
    await withServer(async (post) => {
      const first = await post("baby duckling who is trying to find its mother");
      const firstId = tool(first, "aifirst_confirm_")?.id;
      expect(firstId).toBeDefined();

      const cancelled = await post([{
        type: "tool_result",
        tool_use_id: firstId,
        content: '{"answers":{"AI First":"Cancel"}}',
      }]);
      expect(cancelled.content.some((block) => block.text?.includes("Replay cancelled"))).toBe(true);

      const second = await post("baby duckling who is trying to find its mother");
      const secondId = tool(second, "aifirst_confirm_")?.id;
      expect(secondId).toBeDefined();
      expect(secondId).not.toBe(firstId);

      const repeated = await post([{
        type: "tool_result",
        tool_use_id: firstId,
        content: '{"answers":{"AI First":"Cancel"}}',
      }]);
      expect(tool(repeated, "aifirst_confirm_")?.id).toBe(secondId);

      const accepted = await post([
        {
          type: "tool_result",
          tool_use_id: firstId,
          content: '{"answers":{"AI First":"Cancel"}}',
        },
        {
          type: "tool_result",
          tool_use_id: secondId,
          content: '{"answers":{"AI First":"Run this replay"}}',
        },
      ]);
      expect(tool(accepted, "aifirst_preplan_py-9-01_0")?.name).toBe("Bash");
    });
  });

  test("uses the active planning approval when an older question result is present", async () => {
    await withServer(async (post) => {
      const questions = await post("Design a level editor for the savetheduckling game.");
      const questionId = tool(questions, "aifirst_plan_")?.id;
      expect(questionId).toBeDefined();

      const approval = await post([{
        type: "tool_result",
        tool_use_id: questionId,
        content: JSON.stringify({ answers: {
          level_format: "JSON files (Book Recommended)",
          editor_ui: "Standalone script (Book Recommended)",
          feature_scope: "Core grid placement (Book Recommended)",
        } }),
      }]);
      const approvalId = tool(approval, "aifirst_plan_")?.id;
      expect(approvalId).toBeDefined();
      expect(approvalId).not.toBe(questionId);

      const build = await post([
        {
          type: "tool_result",
          tool_use_id: questionId,
          content: '{"answers":{"Level format":"JSON files (Book Recommended)"}}',
        },
        {
          type: "tool_result",
          tool_use_id: approvalId,
          content: '{"answers":{"Plan":"Approve and build"}}',
        },
      ]);
      expect(tool(build, "aifirst_replay_standalone_py-10-01_0")?.name).toBe("Write");
    });
  });

  test("routes a new prompt after the active planning question is rejected", async () => {
    await withServer(async (post) => {
      const questions = await post("Design a level editor for the savetheduckling game.");
      const questionId = tool(questions, "aifirst_plan_")?.id;
      const routed = await post([
        {
          type: "tool_result",
          tool_use_id: questionId,
          is_error: true,
          content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
        },
        { type: "text", text: "duckling" },
      ]);
      expect(tool(routed, "aifirst_choose_replay_")?.name).toBe("AskUserQuestion");
      expect(routed.content.some((block) => block.text?.includes("This choice needs an LLM"))).toBe(false);
    });
  });
});
