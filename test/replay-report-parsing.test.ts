import { describe, expect, it } from "bun:test";
import { parseShowtailReport } from "../src/replay/showtailReport";
import { CliError } from "../src/output";

const valid = {
  generatedAt: "2026-08-14T00:00:00.000Z",
  displayName: "csv-parser-demo",
  sessionId: "sess-1",
  turns: [
    {
      prompt: { text: "write a csv parser" },
      aiOutputs: [{ text: "here is a parser" }],
      codeChanges: [{ path: "parser.py", diff: "+print(1)" }],
      toolCalls: [{ toolName: "Bash", text: "ok" }],
    },
  ],
};

describe("parseShowtailReport", () => {
  it("parses a minimal valid report", () => {
    const report = parseShowtailReport(valid);
    expect(report.turns).toHaveLength(1);
    expect(report.turns[0].prompt.text).toBe("write a csv parser");
    expect(report.displayName).toBe("csv-parser-demo");
  });

  it("throws bad_report naming the missing field when turns is absent", () => {
    const { turns, ...rest } = valid;
    try {
      parseShowtailReport(rest);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe("bad_report");
      expect((e as CliError).message).toContain("turns");
    }
  });

  it("throws bad_report for a non-object input", () => {
    try {
      parseShowtailReport("not an object");
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe("bad_report");
    }
  });
});
