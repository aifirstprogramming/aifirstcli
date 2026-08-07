import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TARGETS } from "../src/targets";
import { assetNameFor, currentTarget } from "../src/platform";
import type { Target } from "../src/platform";

/**
 * Three places name release artifacts: scripts/build.ts produces them,
 * src/platform.ts picks one for `aifirst update`, and install/install.sh picks
 * one at install time. If they drift, a learner either can't install or gets
 * upgraded onto a binary that won't start. These tests hold them together.
 */

describe("asset naming", () => {
  const cases: [Target, string][] = [
    [{ os: "linux", arch: "x64", variant: "" }, "aifirst-linux-x64"],
    [{ os: "linux", arch: "x64", variant: "-baseline" }, "aifirst-linux-x64-baseline"],
    [{ os: "linux", arch: "x64", variant: "-musl" }, "aifirst-linux-x64-musl"],
    [{ os: "linux", arch: "arm64", variant: "" }, "aifirst-linux-arm64"],
    [{ os: "darwin", arch: "arm64", variant: "" }, "aifirst-darwin-arm64"],
    [{ os: "windows", arch: "x64", variant: "" }, "aifirst-windows-x64.exe"],
    [{ os: "windows", arch: "arm64", variant: "" }, "aifirst-windows-arm64.exe"],
  ];

  for (const [target, expected] of cases) {
    it(`${target.os}/${target.arch}${target.variant} -> ${expected}`, () => {
      expect(assetNameFor(target)).toBe(expected);
    });
  }

  it("every name it can produce is actually built by scripts/build.ts", () => {
    const built = new Set(TARGETS.map((t) => t.asset));
    for (const [target] of cases) {
      expect(built.has(assetNameFor(target))).toBe(true);
    }
  });

  it("build targets have unique asset names", () => {
    const names = TARGETS.map((t) => t.asset);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("currentTarget", () => {
  it("resolves this machine to something we build", () => {
    const target = currentTarget();
    expect(target).toBeDefined();
    expect(TARGETS.map((t) => t.asset)).toContain(assetNameFor(target!));
  });

  it("returns undefined for a platform we do not ship", () => {
    expect(currentTarget("freebsd", "x64")).toBeUndefined();
    expect(currentTarget("linux", "riscv64")).toBeUndefined();
  });

  it("never puts a variant suffix on darwin, which has no baseline build", () => {
    // Bun publishes no darwin baseline target, so requesting one would 404.
    const darwinAssets = TARGETS.filter((t) => t.asset.includes("darwin")).map((t) => t.asset);
    expect(darwinAssets).toEqual(["aifirst-darwin-x64", "aifirst-darwin-arm64"]);
  });
});

describe("install.sh agrees with the build matrix", () => {
  const script = readFileSync(join(import.meta.dir, "..", "install", "install.sh"), "utf8");

  it("composes the same asset name pattern", () => {
    expect(script).toContain('ASSET="aifirst-${OS}-${ARCH}${VARIANT}"');
  });

  it("detects musl and pre-AVX2 CPUs, the two cases that produce a dead binary", () => {
    expect(script).toContain("-musl");
    expect(script).toContain("-baseline");
    expect(script).toContain("avx2");
  });

  it("refuses to install without verifying a checksum", () => {
    expect(script).toContain("refusing to install an unverified binary");
  });

  it("points Windows users at the PowerShell one-liner", () => {
    expect(script).toContain("install.ps1");
  });
});
