import { describe, expect, it } from "bun:test";
import {
  buildArgs,
  selectBuildTargets,
  WINDOWS_COMPANY_NAME,
  WINDOWS_COPYRIGHT,
  WINDOWS_DESCRIPTION,
  WINDOWS_PRODUCT_NAME,
  windowsVersion,
} from "../scripts/build-config";
import { TARGETS } from "../src/targets";

describe("build target selection", () => {
  it("builds only the host OS family by default", () => {
    expect(selectBuildTargets([], "linux", "x64", TARGETS).map((target) => target.asset)).toEqual([
      "aifirst-linux-x64",
      "aifirst-linux-x64-baseline",
      "aifirst-linux-x64-musl",
      "aifirst-linux-arm64",
    ]);
    expect(selectBuildTargets([], "win32", "x64", TARGETS).map((target) => target.asset)).toEqual([
      "aifirst-windows-x64.exe",
      "aifirst-windows-x64-baseline.exe",
      "aifirst-windows-arm64.exe",
    ]);
  });

  it("keeps --local and explicit native targets", () => {
    expect(selectBuildTargets(["--local"], "darwin", "arm64", TARGETS)[0]?.asset).toBe("aifirst-darwin-arm64");
    expect(selectBuildTargets(["--target", "aifirst-linux-arm64"], "linux", "x64", TARGETS)[0]?.bunTarget)
      .toBe("bun-linux-arm64");
  });

  it("rejects obsolete all-platform and cross-host Windows builds", () => {
    expect(() => selectBuildTargets(["--all"], "linux", "x64", TARGETS)).toThrow("no longer supported");
    expect(() => selectBuildTargets(["--target", "bun-windows-x64"], "linux", "x64", TARGETS))
      .toThrow("must be built on Windows");
  });
});

describe("Windows release metadata", () => {
  it("converts semantic versions to four numeric fields", () => {
    expect(windowsVersion("0.8.0")).toBe("0.8.0.0");
    expect(windowsVersion("1.2.3-beta.1")).toBe("1.2.3.0");
    expect(() => windowsVersion("next")).toThrow("semantic X.Y.Z");
  });

  it("adds complete metadata only to native Windows builds", () => {
    const target = TARGETS.find((candidate) => candidate.bunTarget === "bun-windows-x64")!;
    const args = buildArgs(target, "win32", "0.8.0", "src/index.ts", "bin/aifirst.exe");
    expect(args).toContain(`--windows-title=${WINDOWS_PRODUCT_NAME}`);
    expect(args).toContain(`--windows-publisher=${WINDOWS_COMPANY_NAME}`);
    expect(args).toContain("--windows-version=0.8.0.0");
    expect(args).toContain(`--windows-description=${WINDOWS_DESCRIPTION}`);
    expect(args).toContain(`--windows-copyright=${WINDOWS_COPYRIGHT}`);
    expect(args).not.toContain("--bytecode");
  });

  it("keeps non-Windows builds free of Windows-only arguments", () => {
    const target = TARGETS.find((candidate) => candidate.bunTarget === "bun-linux-x64")!;
    const args = buildArgs(target, "linux", "0.8.0", "src/index.ts", "bin/aifirst");
    expect(args.some((arg) => arg.startsWith("--windows-"))).toBe(false);
  });
});
