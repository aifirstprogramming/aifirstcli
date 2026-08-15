import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBookServer } from "../src/commands/serve";
import { replayDir } from "../src/paths";

const servers: { stop(): void }[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(); });

describe("replay server", () => {
  test("serves cached commentary and diffs in sequence", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-replay-"));
    process.env.AIFIRST_STATE_DIR = root;
    const dir = replayDir();
    mkdirSync(dir, { recursive: true });
    const pack = { name: "demo", sourceReportGeneratedAt: "2026-01-01", displayName: "Demo", steps: [{ id: "s-0", promptText: "fake prompt", commentary: ["captured commentary"], codeChanges: [{ path: "fake.ts", diff: "+const fake = true;" }], toolCalls: [] }] };
    await Bun.write(join(dir, "demo.json"), JSON.stringify(pack));
    const server = startBookServer({ port: 0, quiet: true, replay: "demo" });
    servers.push(server);
    const response = await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "anything" }] }) });
    const body = await response.json() as { content: { text?: string }[] };
    expect(body.content[0]?.text).toContain("captured commentary");
    expect(body.content[0]?.text).toContain("```diff");
    delete process.env.AIFIRST_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });
});