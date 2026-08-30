import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { BookServer } from "../src/commands/serve";
import { respond, toolResult } from "../src/bookmode/responder";
import { bodyReply, pacedStreamReply, streamReply } from "../src/bookmode/sse";
import { resolveContent } from "../src/content";
import { emptyLog } from "../src/log/progress";

/**
 * The wire side of book mode.
 *
 * The event sequence is the documented public one, so a client that speaks the
 * Messages API can read it. These tests parse what we emit rather than trusting it,
 * because a malformed stream to a closed client fails in ways that are hard to
 * diagnose from the outside.
 */

const { content } = resolveContent();
const log = emptyLog();
const TOOLS = [{ name: "Bash", input_schema: { properties: { command: { type: "string" } } } }];
const IDS = { messageId: "msg_test", toolUseId: "toolu_test", model: "claude-opus-5" };

/** Minimal SSE parser: what a client has to be able to do with our output. */
function parseEvents(raw: string): { event: string; data: Record<string, unknown> }[] {
  return raw
    .split("\n\n")
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? "";
      const data = JSON.parse(/^data: (.+)$/m.exec(chunk)?.[1] ?? "{}");
      return { event, data };
    });
}

describe("the event stream", () => {
  const reply = respond({ messages: [{ role: "user", content: "Write a Hello World app" }], tools: TOOLS }, content, log);
  const events = parseEvents(streamReply(reply, IDS));
  const names = events.map((e) => e.event);

  it("opens and closes in the documented order", () => {
    expect(names[0]).toBe("message_start");
    expect(names[names.length - 2]).toBe("message_delta");
    expect(names[names.length - 1]).toBe("message_stop");
  });

  it("pairs every block start with a stop", () => {
    expect(names.filter((n) => n === "content_block_start").length).toBe(
      names.filter((n) => n === "content_block_stop").length,
    );
  });

  it("carries the first native replay operation as a tool call", () => {
    const delta = events.find((e) => (e.data.delta as { type?: string })?.type === "input_json_delta");
    expect(delta).toBeDefined();
    const partial = (delta!.data.delta as { partial_json: string }).partial_json;
    expect(JSON.parse(partial).command).toContain("hello.py");
  });

  it("reports the stop reason the reply asked for", () => {
    const last = events.find((e) => e.event === "message_delta");
    expect((last!.data.delta as { stop_reason: string }).stop_reason).toBe("tool_use");
  });

  it("reports zero tokens, because none were spent", () => {
    const start = events[0].data.message as { usage: { input_tokens: number; output_tokens: number } };
    expect(start.usage.input_tokens).toBe(0);
    expect(start.usage.output_tokens).toBe(0);
  });
});

describe("paced event stream", () => {
  it("splits cached prose into delayed deltas before releasing the tool call", async () => {
    const delays: number[] = [];
    const reply = {
      text: "Alpha beta gamma delta epsilon zeta.",
      toolUse: { name: "Bash", input: { command: "echo done" } },
      stopReason: "tool_use" as const,
    };
    const raw = await new Response(pacedStreamReply(reply, IDS, {
      charsPerSecond: 200,
      chunkChars: 8,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    })).text();
    const events = parseEvents(raw);
    const textDeltas = events
      .map((entry) => entry.data.delta as { type?: string; text?: string } | undefined)
      .filter((delta) => delta?.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(2);
    expect(textDeltas.map((delta) => delta?.text ?? "").join("")).toBe(reply.text);
    expect(delays).toHaveLength(textDeltas.length - 1);
    expect(delays.every((delay) => delay >= 10)).toBe(true);
    const finalText = events.reduce(
      (last, entry, index) => (entry.data.delta as { type?: string })?.type === "text_delta" ? index : last,
      -1,
    );
    const toolStart = events.findIndex((entry) => (entry.data.content_block as { type?: string })?.type === "tool_use");
    expect(toolStart).toBeGreaterThan(finalText);
  });
});

describe("the non-streaming body", () => {
  it("carries the same native replay operation", () => {
    const reply = respond(
      { messages: [{ role: "user", content: "Write a Hello World app" }], tools: TOOLS },
      content,
      log,
    );
    const body = bodyReply(reply, IDS) as Record<string, unknown>;
    const blocks = body.content as Record<string, unknown>[];

    expect(body.stop_reason).toBe("tool_use");
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("tool_use");
    expect((blocks[1].input as { command: string }).command).toContain("hello.py");
  });
});

describe("what happened to the command", () => {
  const resultOf = (block: Record<string, unknown>) =>
    toolResult([{ role: "user", content: [block] }]);

  it("reads a plain string result", () => {
    expect(resultOf({ type: "tool_result", content: "Hello, World!" })).toEqual({
      failed: false,
      detail: "Hello, World!",
    });
  });

  it("notices a failure rather than assuming success", () => {
    expect(resultOf({ type: "tool_result", is_error: true, content: "boom" })?.failed).toBe(true);
  });

  it("never claims an exercise was recorded when the command failed", () => {
    const reply = respond(
      {
        messages: [
          { role: "user", content: "Write a Hello World app" },
          { role: "assistant", content: [{ type: "tool_use" }] },
          { role: "user", content: [{ type: "tool_result", is_error: true, content: "This command requires approval" }] },
        ],
        tools: TOOLS,
      },
      content,
      log,
    );
    expect(reply.text).toContain("nothing has been recorded");
    // And it says what to do about this particular failure.
    expect(reply.text).toContain("aifirst init");
  });
});

describe("the server", () => {
  let server: BookServer | undefined;
  let base = "";
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    const { startBookServer } = await import("../src/commands/serve");
    // Count any outbound call the serving path makes. Book mode's whole claim is
    // that nothing leaves the machine, so this is asserted rather than intended.
    globalThis.fetch = ((...args: Parameters<typeof realFetch>) => {
      fetchCalls++;
      return realFetch(...args);
    }) as typeof realFetch;
    server = startBookServer({ port: 0, quiet: true });
    base = server.baseUrl;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    server?.stop();
  });

  const post = (body: unknown) =>
    realFetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("answers the health probe a client makes before talking", async () => {
    const r = await realFetch(`${base}/api/hello`);
    expect(r.status).toBe(200);
  });

  it("uses an ephemeral loopback port", () => {
    expect(new URL(base).hostname).toBe("127.0.0.1");
    expect(new URL(base).port).not.toBe("0");
  });

  it("serves a book prompt over the stream", async () => {
    const before = fetchCalls;
    const r = await post({
      model: "claude-opus-5",
      stream: true,
      messages: [{ role: "user", content: "Write a Hello World app" }],
      tools: TOOLS,
    });
    const text = await r.text();
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("hello.py");

    // The test's own requests go through the saved original, so the counter only
    // moves if the *server* reached out. Book mode's claim is that it never does.
    expect(fetchCalls - before).toBe(0);
  });

  it("serves the same answer without streaming", async () => {
    const r = await post({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "Write a Hello World app" }],
      tools: TOOLS,
    });
    const body = (await r.json()) as { stop_reason: string; usage: { input_tokens: number } };
    expect(body.stop_reason).toBe("tool_use");
    expect(body.usage.input_tokens).toBe(0);
  });

  it("counts tokens as zero, which is what a reader is spending", async () => {
    const r = await realFetch(`${base}/v1/messages/count_tokens`, { method: "POST", body: "{}" });
    const body = (await r.json()) as { input_tokens: number };
    expect(body.input_tokens).toBe(0);
  });

  it("rejects a malformed body rather than crashing", async () => {
    const r = await realFetch(`${base}/v1/messages`, { method: "POST", body: "not json" });
    expect(r.status).toBe(400);
  });
});
