import { describe, expect, it } from "bun:test";
import { buildReplayPack } from "../src/replay/importer";
import type { ShowtailReport } from "../src/replay/showtailReport";
import { renderReplayStep } from "../src/replay/contentSource";

const report: ShowtailReport = {
  generatedAt: "2026-08-14T00:00:00.000Z",
  displayName: "csv-parser-demo",
  sessionId: "sess-1",
  turns: [
    {
      prompt: { text: "write a csv parser" },
      aiOutputs: [{ text: "here is a parser" }],
      codeChanges: [{ path: "parser.py", diff: "+print(1)" }],
      toolCalls: [],
    },
    {
      prompt: { text: "run it" },
      aiOutputs: [{ text: "ran clean" }],
      codeChanges: [],
      toolCalls: [{ toolName: "Bash", isError: false, text: "1,2,3" }],
      recap: { durationMs: 500, inputTokens: 10, outputTokens: 20 },
    },
  ],
} as unknown as ShowtailReport;

describe("buildReplayPack", () => {
  it("produces steps in original turn order with fields carried through unchanged", () => {
    const pack = buildReplayPack("demo", report);
    expect(pack.name).toBe("demo");
    expect(pack.displayName).toBe("csv-parser-demo");
    expect(pack.sourceReportGeneratedAt).toBe(report.generatedAt);
    expect(pack.steps).toHaveLength(2);

    expect(pack.steps[0].promptText).toBe("write a csv parser");
    expect(pack.steps[0].commentary).toEqual(["here is a parser"]);
    expect(pack.steps[0].codeChanges).toEqual([{ path: "parser.py", diff: "+print(1)" }]);
    expect(pack.steps[0].toolCalls).toEqual([]);

    expect(pack.steps[1].promptText).toBe("run it");
    expect(pack.steps[1].toolCalls).toEqual([{ toolName: "Bash", isError: false, text: "1,2,3" }]);
    expect(pack.steps[1].recap).toEqual({ durationMs: 500, inputTokens: 10, outputTokens: 20 });
  });

  it("gives each step a stable id derived from the session and its index", () => {
    const pack = buildReplayPack("demo", report);
    expect(pack.steps[0].id).toBe("sess-1-0");
    expect(pack.steps[1].id).toBe("sess-1-1");
  });

  it("orders timestamped commentary, changes, and tools for replay", () => {
    const timestamped = {
      ...report,
      sessionId: undefined,
      turns: [{
        prompt: { text: "duckling" },
        aiOutputs: [{ text: "first", timestamp: "2026-08-19T00:00:01.000Z" }, { text: "last", timestamp: "2026-08-19T00:00:04.000Z" }],
        codeChanges: [{ path: "main.py", diff: "+code", timestamp: "2026-08-19T00:00:03.000Z" }],
        toolCalls: [{ toolName: "Bash", text: "output", timestamp: "2026-08-19T00:00:02.000Z" }],
      }],
    };
    const pack = buildReplayPack("duckling", timestamped);
    expect(pack.steps[0].id).toBe("duckling-0");
    const rendered = renderReplayStep(pack.steps[0]);
    expect(rendered.indexOf("first")).toBeLessThan(rendered.indexOf("Bash"));
    expect(rendered.indexOf("Bash")).toBeLessThan(rendered.indexOf("+code"));
    expect(rendered.indexOf("+code")).toBeLessThan(rendered.indexOf("last"));
  });

  it("carries canonical operations into an inline replay", () => {
    const executable = { ...report, turns: [{ ...report.turns[0], operations: [{ type: "write" as const, path: "parser.py", content: "print(1)\n" }] }] };
    expect(buildReplayPack("demo", executable).steps[0].replay).toEqual({
      prompt: "write a csv parser",
      commentary: ["here is a parser"],
      operations: [{ type: "write", path: "parser.py", content: "print(1)\n" }],
    });
  });
});
