import { describe, expect, it } from "bun:test";
import { boolFlag, formatFlag, numberFlag, parse, stringFlag } from "../src/cli";
import { CliError } from "../src/output";

describe("parse", () => {
  it("takes the first bare word as the command", () => {
    expect(parse(["show", "py-1-01"])).toMatchObject({ command: "show", positionals: ["py-1-01"] });
  });

  it("handles --flag=value", () => {
    expect(stringFlag(parse(["show", "x", "--format=json"]), "format")).toBe("json");
  });

  it("handles --flag value for flags that take one", () => {
    expect(stringFlag(parse(["show", "x", "--format", "json"]), "format")).toBe("json");
  });

  it("treats an unknown --flag as boolean rather than eating the next word", () => {
    // `--yes py-1-01` must not consume the id as the value of --yes.
    const args = parse(["done", "--yes", "py-1-01"]);
    expect(boolFlag(args, "yes")).toBe(true);
    expect(args.positionals).toEqual(["py-1-01"]);
  });

  it("supports short flags", () => {
    expect(stringFlag(parse(["show", "x", "-f", "json"]), "format")).toBe("json");
    expect(boolFlag(parse(["init", "-y"]), "yes")).toBe(true);
  });

  it("passes everything after -- through as positionals", () => {
    expect(parse(["search", "--", "--not-a-flag"]).positionals).toEqual(["--not-a-flag"]);
  });

  it("keeps multi-word search text as separate positionals", () => {
    expect(parse(["search", "Write", "a", "Hello", "World", "app"]).positionals).toEqual([
      "Write",
      "a",
      "Hello",
      "World",
      "app",
    ]);
  });

  it("rejects an unknown short flag", () => {
    expect(() => parse(["show", "-Z"])).toThrow(CliError);
  });

  it("returns an empty command for no arguments", () => {
    expect(parse([]).command).toBe("");
  });
});

describe("formatFlag", () => {
  it("defaults to text", () => {
    expect(formatFlag(parse(["list"]))).toBe("text");
  });

  it("rejects a format a command does not support", () => {
    expect(() => formatFlag(parse(["show", "x", "--format", "md"]), ["text", "json"])).toThrow(
      /--format must be one of/,
    );
  });

  it("rejects an unknown format outright", () => {
    expect(() => formatFlag(parse(["list", "--format", "yaml"]))).toThrow(CliError);
  });
});

describe("numberFlag", () => {
  it("parses an integer", () => {
    expect(numberFlag(parse(["list", "--chapter", "2"]), "chapter")).toBe(2);
  });

  it("is undefined when absent", () => {
    expect(numberFlag(parse(["list"]), "chapter")).toBeUndefined();
  });

  it("rejects a non-number", () => {
    expect(() => numberFlag(parse(["list", "--chapter", "two"]), "chapter")).toThrow(CliError);
  });
});
