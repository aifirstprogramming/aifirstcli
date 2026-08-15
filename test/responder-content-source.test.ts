import { describe, expect, it } from "bun:test";
import type { ContentSource, SourceReply, SourceState } from "../src/bookmode/contentSource";
import { respond } from "../src/bookmode/responder";
import { resolveContent } from "../src/content";
import { emptyLog } from "../src/log/progress";

const { content } = resolveContent();
const log = emptyLog();
const TOOLS = [{ name: "Bash", input_schema: { properties: { command: { type: "string" } } } }];
const userTurn = (text: string) => ({ messages: [{ role: "user", content: text }], tools: TOOLS });

class StubSource implements ContentSource {
  calls: { typed: string; state: SourceState }[] = [];
  reply: SourceReply | undefined = { text: "stubbed answer", exerciseId: "stub-1", stopReason: "end_turn" as const };

  next(typed: string, state: SourceState): SourceReply | undefined {
    this.calls.push({ typed, state });
    return this.reply;
  }
}

describe("respond with a ContentSource", () => {
  it("calls the source only when no chat command matched and no tool-result arrived", () => {
    const stub = new StubSource();
    const reply = respond(userTurn("write a csv parser"), content, log, {}, stub);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].typed).toBe("write a csv parser");
    expect(reply.text).toBe("stubbed answer");
    expect(reply.exerciseId).toBe("stub-1");
  });

  it("does not call the source for a chat command", () => {
    const stub = new StubSource();
    respond(userTurn("aifirst next"), content, log, {}, stub);
    expect(stub.calls).toHaveLength(0);
  });

  it("does not call the source when a tool-result just arrived", () => {
    const stub = new StubSource();
    respond(
      {
        messages: [
          { role: "user", content: "write a csv parser" },
          { role: "assistant", content: [{ type: "tool_use" } as Record<string, unknown>] },
          { role: "user", content: [{ type: "tool_result", content: "ok" } as Record<string, unknown>] },
        ],
        tools: TOOLS,
      },
      content,
      log,
      {},
      stub,
    );
    expect(stub.calls).toHaveLength(0);
  });

  it("threads the source's reply through unchanged, including a tool call", () => {
    const stub = new StubSource();
    stub.reply = {
      text: "run this",
      exerciseId: "stub-2",
      stopReason: "tool_use",
      toolUse: { name: "Bash", input: { command: "echo hi" } },
    };
    const reply = respond(userTurn("write a csv parser"), content, log, {}, stub);
    expect(reply.stopReason).toBe("tool_use");
    expect(reply.toolUse).toEqual({ name: "Bash", input: { command: "echo hi" } });
    expect(reply.exerciseId).toBe("stub-2");
  });

  it("falls back to refusal when the source returns nothing", () => {
    const stub = new StubSource();
    stub.reply = undefined;
    const reply = respond(userTurn("write a csv parser"), content, log, {}, stub);
    expect(reply.stopReason).toBe("end_turn");
    expect(reply.exerciseId).toBeUndefined();
  });
});
