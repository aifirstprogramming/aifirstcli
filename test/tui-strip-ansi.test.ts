import { describe, expect, test } from "bun:test";
import * as session from "../src/tui/session";

// Learn shows embedded program output, titles and labels through this function.
const stripAnsi = (value: string): string =>
  (session as unknown as { stripAnsi: (value: string) => string }).stripAnsi(value);

describe("TUI ANSI stripping", () => {
  test("keeps the visible text of an OSC 8 hyperlink", () => {
    expect(stripAnsi("see \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ after")).toBe("see link after");
  });

  test("keeps text between an ESC-backslash OSC and a later BEL", () => {
    expect(stripAnsi("\x1b]66;w=1; \x1b\\Hello\x1b]0;title\x07")).toBe("Hello");
  });

  test("still removes BEL-terminated OSC and CSI sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07\x1b[1mbold\x1b[0m \x1b[2Kplain")).toBe("bold plain");
  });
});
