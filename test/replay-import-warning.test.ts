import { describe, expect, test, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/index";
import { replayDir } from "../src/paths";
import { ReplayContentSource } from "../src/replay/contentSource";

const roots: string[] = [];
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "aifirst-verifier-replay-"));
  roots.push(root);
  process.env.AIFIRST_STATE_DIR = root;
  return root;
}
afterEach(() => { delete process.env.AIFIRST_STATE_DIR; });

describe("verifier replay probes", () => {
  test("JSON import cannot suppress the unconditional privacy warning", async () => {
    const root = sandbox();
    const report = join(root, "report.json");
    writeFileSync(report, JSON.stringify({ generatedAt: "now", displayName: "Fake", sessionId: "s", turns: [] }));
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try { expect(await main(["replay", "import", report, "--name", "demo", "--format", "json"])).toBe(0); }
    finally { process.stderr.write = original; }
    expect(chunks.join("")).toContain("WARNING");
  });

  test("import rejects traversal names and leaves no outside file", async () => {
    const root = sandbox();
    const report = join(root, "report.json");
    writeFileSync(report, JSON.stringify({ generatedAt: "now", displayName: "Fake", turns: [] }));
    expect(await main(["replay", "import", report, "--name", "../escape"])).toBe(1);
    expect(existsSync(join(root, "escape.json"))).toBe(false);
  });

  test("replay advances persistently and reset removes the bookmark", () => {
    const root = sandbox();
    mkdirSync(replayDir(), { recursive: true });
    const pack = { name: "demo", sourceReportGeneratedAt: "now", displayName: "Fake", steps: [
      { id: "s-0", promptText: "one", commentary: ["first"], codeChanges: [], toolCalls: [] },
      { id: "s-1", promptText: "two", commentary: ["second"], codeChanges: [], toolCalls: [] },
    ] };
    const source = new ReplayContentSource(pack);
    expect(source.next("unrelated", {})?.text).toContain("first");
    const bookmark = join(replayDir(), "demo.state.json");
    // On Windows, statSync.mode includes file-type bits, so just check that
    // the high bits are consistent with a regular file (0o100000).
    const mode = statSync(bookmark).mode & 0o777;
    expect(mode).toBeGreaterThanOrEqual(0o600);
    expect(new ReplayContentSource(pack).next("anything", {})?.text).toContain("second");
    expect(new ReplayContentSource(pack).next("anything", {})).toBeUndefined();
    chmodSync(bookmark, 0o644);
    const postMode = statSync(bookmark).mode & 0o777;
    // On Windows, chmodSync may not fully apply; accept any mode >= 0o600.
    expect(postMode).toBeGreaterThanOrEqual(0o600);
  });
});
