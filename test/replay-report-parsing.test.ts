import { describe, expect, it } from "bun:test";
import { parseShowtailReport } from "../src/replay/showtailReport";
import { CliError } from "../src/output";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  it("accepts the sanitized duckling Showtail shape with a null session id", () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "showtail-duckling.json"), "utf8"));
    const report = parseShowtailReport(fixture);
    expect(report.sessionId).toBeUndefined();
    expect(report.turns).toHaveLength(2);
    expect(report.turns[0].codeChanges).toHaveLength(2);
    expect(report.turns[1].toolCalls[0]?.isError).toBe(true);
  });

  it("keeps only the fox turn from its aggregate Showtail report", () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "showtail-duckling-fox.json"), "utf8"));
    const report = parseShowtailReport(fixture);
    expect(report.turns).toHaveLength(1);
    expect(report.turns[0].prompt.text).toBe("The game currently has no enemies. Add a fox to the game.");
    expect(report.turns[0].prompt.timestamp).toBe("2026-08-21T15:29:56.717Z");
    expect(report.turns[0].codeChanges).toHaveLength(5);
  });

  it("keeps only the multi-level turn from its aggregate Showtail report", () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "showtail-duckling-levels.json"), "utf8"));
    const report = parseShowtailReport(fixture);
    expect(report.turns).toHaveLength(1);
    expect(report.turns[0].prompt.text).toBe(
      "Make two more levels for the game. Each level should get harder with more obstacles and enemies.",
    );
    expect(report.turns[0].prompt.timestamp).toBe("2026-08-21T21:34:48.724Z");
    expect(report.turns[0].codeChanges).toHaveLength(4);
  });

  it("parses canonical executable operations when Showtail exports them", () => {
    const report = parseShowtailReport({ ...valid, turns: [{ ...valid.turns[0], operations: [
      { type: "write", path: "main.py", content: "print('ok')\n" },
      { type: "command", command: ["python3", "main.py"], env: { MODE: "test" }, expectedStdout: "ok\n" },
    ] }] });
    expect(report.turns[0].operations).toHaveLength(2);
  });

  it("parses read and edit operations from enriched reports", () => {
    const report = parseShowtailReport({ ...valid, turns: [{ ...valid.turns[0], operations: [
      { type: "read", path: "main.py" },
      { type: "edit", path: "main.py", oldText: "before", newText: "after", replaceAll: true },
      { type: "command", command: ["python3", "main.py"], readOnly: true },
    ] }] });
    expect(report.turns[0].operations).toEqual([
      { type: "read", path: "main.py" },
      { type: "edit", path: "main.py", oldText: "before", newText: "after", replaceAll: true },
      { type: "command", command: ["python3", "main.py"], readOnly: true },
    ]);
  });
});
