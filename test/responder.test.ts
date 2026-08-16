import { describe, expect, it } from "bun:test";
import { carriesToolResult, readerText, respond, shellTool } from "../src/bookmode/responder";
import { resolveContent } from "../src/content";
import { emptyLog } from "../src/log/progress";

/**
 * Book mode's whole behaviour, decided without a socket.
 *
 * The point of the feature is that a book exercise needs no model at request time,
 * because the answer was computed and committed at authoring time. These tests are
 * where that claim is actually checked.
 */

const { content } = resolveContent();
const log = emptyLog();

/** The shape Claude Code sends: a shell tool among many others. */
const TOOLS = [
  { name: "Read", input_schema: { properties: { file_path: { type: "string" } } } },
  { name: "Bash", input_schema: { properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Write", input_schema: { properties: { content: { type: "string" } } } },
];

const userTurn = (text: string) => ({ messages: [{ role: "user", content: text }], tools: TOOLS });

describe("shellTool discovery", () => {
  it("finds the tool that takes a command, whatever it is called", () => {
    expect(shellTool(TOOLS)).toBe("Bash");
    expect(shellTool([{ name: "RunShell", input_schema: { properties: { command: { type: "string" } } } }])).toBe(
      "RunShell",
    );
  });

  it("returns nothing when no tool can run a command", () => {
    expect(shellTool([{ name: "Read", input_schema: { properties: { file_path: { type: "string" } } } }])).toBeUndefined();
    expect(shellTool(undefined)).toBeUndefined();
  });
});

describe("reading what the reader typed", () => {
  it("ignores context the client injects around it", () => {
    const text = readerText([
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>You are in a git repo</system-reminder>" },
          { type: "text", text: "Write a Hello World app" },
        ],
      },
    ]);
    expect(text).toBe("Write a Hello World app");
  });

  it("takes the most recent user turn, not the first", () => {
    expect(
      readerText([
        { role: "user", content: "Write a Hello World app" },
        { role: "assistant", content: "..." },
        { role: "user", content: "Ask for a pet's type and name" },
      ]),
    ).toBe("Ask for a pet's type and name");
  });

  it("skips tool results, which are not something the reader typed", () => {
    const messages = [
      { role: "user", content: [{ type: "tool_result", content: "ok" } as Record<string, unknown>] },
    ];
    expect(readerText(messages)).toBe("");
    expect(carriesToolResult(messages)).toBe(true);
  });
});

describe("answering a book prompt", () => {
  it("returns the book's code and asks the client to run it", () => {
    const reply = respond(userTurn("Write a Hello World app"), content, log);

    expect(reply.exerciseId).toBe("py-1-01");
    expect(reply.stopReason).toBe("tool_use");
    expect(reply.toolUse?.name).toBe("Bash");
    expect(reply.toolUse?.input.command).toBe("aifirst run py-1-01");

    // The code in the reply is the book's, byte for byte.
    const step = content.steps.find((s) => s.id === "py-1-01")!;
    expect(reply.text).toContain(step.response);
  });

  it("includes the stored explanation, not an improvised one", () => {
    const reply = respond(userTurn("Write a Hello World app"), content, log);
    const step = content.steps.find((s) => s.id === "py-1-01")!;
    expect(reply.text).toContain(step.explanation!.summary);
  });

  it("still answers when the client offers no shell tool", () => {
    const reply = respond(
      { messages: [{ role: "user", content: "Write a Hello World app" }], tools: [] },
      content,
      log,
    );
    expect(reply.stopReason).toBe("end_turn");
    expect(reply.toolUse).toBeUndefined();
    // The reader is told the command rather than left with nothing to do.
    expect(reply.text).toContain("aifirst run py-1-01");
  });

  it("keeps a Python reader out of the Java book", () => {
    const reply = respond(userTurn("Write a Hello World app"), content, log, { language: "python" });
    expect(reply.exerciseId?.startsWith("py-")).toBe(true);
  });
});

describe("closing the loop", () => {
  it("reports progress once the exercise has run", () => {
    const reply = respond(
      {
        messages: [
          { role: "user", content: "Write a Hello World app" },
          { role: "assistant", content: [{ type: "tool_use" } as Record<string, unknown>] },
          { role: "user", content: [{ type: "tool_result", content: "Hello, World!" } as Record<string, unknown>] },
        ],
        tools: TOOLS,
      },
      content,
      log,
    );
    expect(reply.stopReason).toBe("end_turn");
    expect(reply.toolUse).toBeUndefined();
    expect(reply.text).toContain("Ran clean");
  });
});

describe("chat next", () => {
  it("returns the complete exercise and one shell action", () => {
    const reply = respond(
      { messages: [{ role: "user", content: "aifirst next" }], tools: TOOLS },
      content,
      log,
    );

    expect(reply.stopReason).toBe("tool_use");
    expect(reply.exerciseId).toBe(content.examples[0].id);
    const step = content.steps.find((item) => item.exampleId === content.examples[0].id)!;
    expect(reply.text).toContain(step.prompt);
    expect(reply.text).toContain(`\`\`\`${content.examples[0].language}`);
    expect(reply.toolUse?.input.command).toBe(`aifirst run ${step.id}`);
  });

  it("returns a complete manual action without a shell tool", () => {
    const reply = respond(
      { messages: [{ role: "user", content: "aifirst next" }], tools: [] },
      content,
      log,
    );

    const step = content.steps.find((item) => item.exampleId === content.examples[0].id)!;
    expect(reply.stopReason).toBe("end_turn");
    expect(reply.toolUse).toBeUndefined();
    expect(reply.text).toContain(`aifirst run ${step.id}`);
    expect(reply.text).toContain(step.prompt);
  });
});

describe("a question the book cannot answer", () => {
  const offBook = respond(userTurn("why is my recursion segfaulting in Rust"), content, log);

  it("refuses rather than guessing", () => {
    expect(offBook.stopReason).toBe("end_turn");
    expect(offBook.toolUse).toBeUndefined();
    expect(offBook.exerciseId).toBeUndefined();
  });

  it("says how to leave book mode, so the reader is not stuck", () => {
    expect(offBook.text).toContain("aifirst book-mode off");
  });

  it("never pretends a model answered", () => {
    expect(offBook.text.toLowerCase()).toContain("no model is running");
  });
});
