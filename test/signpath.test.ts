import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("SignPath approval prerequisites", () => {
  it("publishes the required code-signing policy disclosures", () => {
    const policy = readFileSync(join(root, "CODE_SIGNING_POLICY.md"), "utf8");
    expect(policy).toContain("# Code signing policy");
    expect(policy).toContain("SignPath.io");
    expect(policy).toContain("SignPath Foundation");
    expect(policy).toContain("steveonjava");
    expect(policy).toContain("does not collect telemetry");
  });

  it("defines exactly the Windows release files and metadata to sign", () => {
    const config = readFileSync(join(root, ".signpath", "artifact-configuration.xml"), "utf8");
    for (const asset of [
      "aifirst-windows-x64.exe",
      "aifirst-windows-x64-baseline.exe",
      "aifirst-windows-arm64.exe",
    ]) {
      expect(config.match(new RegExp(`path="${asset.replaceAll(".", "\\.")}"`, "g"))?.length).toBe(1);
    }
    expect(config.match(/<authenticode-sign \/>/g)?.length).toBe(3);
    expect(config).toContain('product-name="AI First CLI"');
    expect(config).toContain('product-version="${version}"');
    expect(config).toContain('company-name="AI First Programming"');
    expect(config).toContain('copyright="Copyright (c) 2026 Stephen Chin, Cassandra Chin, and Jennifer Reif"');
  });

  it("pins Bun and keeps bytecode out of compiled releases", () => {
    expect(readFileSync(join(root, ".bun-version"), "utf8").trim()).toBe("1.4.0");
    expect(readFileSync(join(root, "scripts", "build.ts"), "utf8")).not.toContain('"--bytecode"');
  });

  it("builds Windows releases natively and keeps manual runs publish-free", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("build-windows:");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("name: binaries-windows-unsigned");
    expect(workflow).toContain("if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
    expect(workflow).not.toContain("build-linux-windows");
  });

  it("ships explicit Apache licensing, notice, and trademark terms", () => {
    const license = readFileSync(join(root, "LICENSE"), "utf8");
    const notice = readFileSync(join(root, "NOTICE"), "utf8");
    const trademarks = readFileSync(join(root, "TRADEMARKS.md"), "utf8");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(notice).toContain("Stephen Chin, Cassandra Chin, and Jennifer Reif");
    expect(trademarks.replace(/\s+/g, " ")).toContain("does not grant permission to use these trademarks");
    expect(pkg.license).toBe("Apache-2.0");
  });
});
