import { describe, expect, it } from "bun:test";
import { respond } from "../src/bookmode/responder";
import { resolveContent } from "../src/content";
import { emptyLog } from "../src/log/progress";

const { content } = resolveContent();
const log = emptyLog();
const tools = [{ name: "Bash", input_schema: { properties: { command: { type: "string" } } } }];

function chat(text: string) {
  return respond({ messages: [{ role: "user", content: text }], tools }, content, log);
}

describe("local learning chat commands", () => {
  it("accepts both exact aifirst command spellings", () => {
    for (const text of ["/aifirst next", "aifirst next"]) {
      const reply = chat(text);
      expect(["end_turn", "tool_use"]).toContain(reply.stopReason);
      expect(reply.text).toContain("## Code");
      expect(reply.text).toContain("## Explanation");
      expect(reply.text.includes("aifirst run") || reply.toolUse?.input.command?.toString().startsWith("aifirst run")).toBe(true);
    }
  });

  it("renders stored replies as Code then Explanation", () => {
    const reply = chat("aifirst show py-1-01");
    expect(reply.text).toContain("## Code");
    expect(reply.text).toContain("## Explanation");
    expect(reply.text.indexOf("## Code")).toBeLessThan(reply.text.indexOf("## Explanation"));
    expect(reply.text).toContain('print("Hello, World!")');
    expect(reply.text).toContain("content-library walkthrough");
    expect(reply.text.toLowerCase()).not.toContain("print book");
    expect(reply.text.toLowerCase()).not.toContain("explanation from the book");
  });

  it("refuses embedded prose and withheld commands without a tool call", () => {
    for (const text of ["please /aifirst next", "aifirst reset --all", "aifirst init"]) {
      const reply = chat(text);
      expect(reply.stopReason).toBe("end_turn");
      expect(reply.toolUse).toBeUndefined();
      expect(reply.text).toContain("local learning");
    }
  });
});
