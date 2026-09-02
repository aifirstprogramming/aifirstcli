#!/usr/bin/env bun
/**
 * Compiles standalone binaries with `bun build --compile`.
 *
 * The book content is bundled in via static JSON imports (see
 * src/content/embedded.generated.ts), so each binary is self-contained: download
 * it, run it, and every exercise is there with no network.
 *
 * Usage:
 *   bun scripts/build.ts            all targets for the host OS
 *   bun scripts/build.ts --local    just this machine's target, into ./bin
 *   bun scripts/build.ts --target bun-linux-x64
 *
 * macOS caveat: Apple Silicon refuses to execute an unsigned arm64 binary, so
 * darwin artifacts must be built and codesigned on a macOS runner. Cross-compiled
 * darwin binaries produced here are for local testing only — see
 * .github/workflows/release.yml.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { TARGETS } from "../src/targets";
import type { BuildTarget } from "../src/targets";
import { buildArgs, selectBuildTargets } from "./build-config";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "src", "index.ts");
const OUT_DIR = join(ROOT, "bin");

function selectTargets(): BuildTarget[] {
  if (process.platform !== "linux" && process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error(`Unsupported build host: ${process.platform}`);
  }
  return selectBuildTargets(process.argv.slice(2), process.platform, process.arch, TARGETS);
}

function openTuiNativePackage(target: BuildTarget): string {
  if (target.bunTarget.startsWith("bun-linux-x64")) {
    return target.bunTarget.endsWith("-musl") ? "@opentui/core-linux-x64-musl" : "@opentui/core-linux-x64";
  }
  if (target.bunTarget === "bun-linux-arm64") return "@opentui/core-linux-arm64";
  if (target.bunTarget === "bun-darwin-x64") return "@opentui/core-darwin-x64";
  if (target.bunTarget === "bun-darwin-arm64") return "@opentui/core-darwin-arm64";
  if (target.bunTarget.startsWith("bun-windows-x64")) return "@opentui/core-win32-x64";
  if (target.bunTarget === "bun-windows-arm64") return "@opentui/core-win32-arm64";
  throw new Error(`No OpenTUI native package for ${target.bunTarget}`);
}

async function ensureOpenTuiNativePackage(target: BuildTarget): Promise<void> {
  const packageName = openTuiNativePackage(target);
  const directory = join(ROOT, "node_modules", ...packageName.split("/"));
  if (existsSync(directory)) return;

  const version = pkg.optionalDependencies?.[packageName as keyof typeof pkg.optionalDependencies];
  if (!version) throw new Error(`${packageName} is missing from optionalDependencies`);
  const scratch = mkdtempSync(join(tmpdir(), "aifirst-opentui-native-"));
  try {
    const pack = Bun.spawn(["npm", "pack", `${packageName}@${version}`, "--silent", "--pack-destination", scratch], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(pack.stdout).text(), new Response(pack.stderr).text()]);
    await pack.exited;
    if (pack.exitCode !== 0) throw new Error(`Could not fetch ${packageName}: ${stderr || stdout}`);
    const archive = join(scratch, stdout.trim().split(/\r?\n/).at(-1)!);
    const extract = Bun.spawn(["tar", "-xzf", archive, "-C", scratch], { stdout: "pipe", stderr: "pipe" });
    const extractError = new Response(extract.stderr).text();
    await extract.exited;
    if (extract.exitCode !== 0) throw new Error(`Could not unpack ${packageName}: ${await extractError}`);
    mkdirSync(join(directory, ".."), { recursive: true });
    cpSync(join(scratch, "package"), directory, { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function build(target: BuildTarget): Promise<void> {
  await ensureOpenTuiNativePackage(target);
  const outfile = join(OUT_DIR, target.asset);
  const args = buildArgs(target, process.platform as "linux" | "darwin" | "win32", pkg.version, ENTRY, outfile);

  // Use the Bun that's running this script rather than whatever "bun" resolves
  // to on PATH — CI images and local shells don't always agree.
  const proc = Bun.spawn([process.execPath, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error(`Build failed for ${target.bunTarget}:\n${stdout}\n${stderr}`);
  }

  const size = statSync(outfile).size;
  console.log(`  ${target.asset.padEnd(36)} ${(size / 1024 / 1024).toFixed(1)} MB`);
}

const targets = selectTargets();
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

console.log(`Building ${targets.length} target(s):`);
for (const target of targets) {
  await build(target);
}
console.log(`\nOutput: ${OUT_DIR}`);
