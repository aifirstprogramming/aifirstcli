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

import { mkdirSync, rmSync, statSync } from "node:fs";
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

async function build(target: BuildTarget): Promise<void> {
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
