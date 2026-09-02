import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_LEARN_CHARS_PER_SECOND, learnTextRate } from "../src/commands/learn";

const original = process.env.AIFIRST_LEARN_CHARS_PER_SECOND;

afterEach(() => {
  if (original === undefined) delete process.env.AIFIRST_LEARN_CHARS_PER_SECOND;
  else process.env.AIFIRST_LEARN_CHARS_PER_SECOND = original;
});

describe("aifirst learn text pacing", () => {
  test("uses a readable default that is still faster than normal model output", () => {
    delete process.env.AIFIRST_LEARN_CHARS_PER_SECOND;
    expect(learnTextRate()).toBe(DEFAULT_LEARN_CHARS_PER_SECOND);
    expect(DEFAULT_LEARN_CHARS_PER_SECOND).toBe(540);
  });

  test("can be disabled or bounded through the environment", () => {
    process.env.AIFIRST_LEARN_CHARS_PER_SECOND = "0";
    expect(learnTextRate()).toBeUndefined();
    process.env.AIFIRST_LEARN_CHARS_PER_SECOND = "10";
    expect(learnTextRate()).toBe(30);
    process.env.AIFIRST_LEARN_CHARS_PER_SECOND = "999999";
    expect(learnTextRate()).toBe(100_000);
  });
});
