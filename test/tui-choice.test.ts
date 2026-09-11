import { describe, expect, test } from "bun:test";
import { tuiChoiceDetail } from "../src/tui/session";

describe("OpenTUI choice details", () => {
  test("retains an immutable book default without truncating or rewriting it", () => {
    const text = "A long captured Other response that must remain byte-for-byte visible to the reader.";
    expect(tuiChoiceDetail({
      key: "book_default",
      label: "Use book default",
      description: text,
      preview: text,
      badge: "BOOK DEFAULT",
    })).toBe(`BOOK DEFAULT\nUse book default\n${text}`);
  });

  test("includes distinct source descriptions and previews", () => {
    expect(tuiChoiceDetail({
      key: "source",
      label: "Source label (Recommended)",
      description: "Source description.",
      preview: "Source preview.",
    })).toBe("Option details\nSource label (Recommended)\nSource description.\n\nSource preview.");
  });
});
