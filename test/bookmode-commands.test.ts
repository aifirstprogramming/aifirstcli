import { describe, expect, it } from "bun:test";
import { parseChatCommand } from "../src/bookmode/commands";

describe("local chat command parser", () => {
  it("accepts exact aliases and quoted search arguments", () => {
    expect(parseChatCommand("/aifirst next")).toEqual({ command: "next", positionals: [] });
    expect(parseChatCommand("aifirst show py-1-01")).toEqual({ command: "show", positionals: ["py-1-01"] });
    expect(parseChatCommand('aifirst search "Hello World"')).toEqual({
      command: "search",
      positionals: ["Hello World"],
    });
  });

  it("rejects prose, whitespace variants, and flags", () => {
    for (const text of ["please /aifirst next", "aifirst  next", "aifirst next ", "aifirst reset --all"]) {
      expect(parseChatCommand(text)).toBeUndefined();
    }
  });
});
