/**
 * Which release artifact belongs on this machine.
 *
 * Two variants exist beyond plain os/arch, and picking wrong means a binary that
 * dies on launch rather than one that merely misbehaves:
 *
 *  - **baseline** — Bun's default x64 build uses AVX2. Plenty of machines in
 *    classrooms and hand-me-down laptops predate it, and the non-baseline binary
 *    crashes with an illegal instruction on those.
 *  - **musl** — Alpine and other musl-libc distributions can't run the glibc build.
 *
 * `install.sh` implements the same decision in shell. The two must agree, or a
 * learner who installs successfully will break on their first `aifirst update`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";

export type Os = "linux" | "darwin" | "windows";
export type Arch = "x64" | "arm64";

export interface Target {
  os: Os;
  arch: Arch;
  /** "", "-baseline" or "-musl". */
  variant: string;
}

/** Does this CPU support AVX2? Only meaningful for x64. */
export function hasAvx2(): boolean {
  if (process.platform === "linux") {
    try {
      return /^flags\s*:.*\bavx2\b/m.test(readFileSync("/proc/cpuinfo", "utf8"));
    } catch {
      // Unreadable /proc: assume the safer (baseline) build.
      return false;
    }
  }
  // Apple Silicon is arm64, and every x64 Mac Bun supports has AVX2.
  return true;
}

/** Is this a musl-libc system (Alpine and friends)? */
export function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    if (readdirSync("/lib").some((f) => f.startsWith("ld-musl-"))) return true;
  } catch {
    /* fall through */
  }
  return existsSync("/etc/alpine-release");
}

export function currentTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): Target | undefined {
  const os: Os | undefined =
    platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : undefined;
  const cpu: Arch | undefined = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (!os || !cpu) return undefined;

  let variant = "";
  if (os === "linux" && isMusl()) {
    variant = "-musl";
  } else if (cpu === "x64" && os !== "darwin" && !hasAvx2()) {
    variant = "-baseline";
  }

  return { os, arch: cpu, variant };
}

/** Release asset filename for a target. Must match scripts/build.ts and install.sh. */
export function assetNameFor(target: Target): string {
  return `aifirst-${target.os}-${target.arch}${target.variant}${target.os === "windows" ? ".exe" : ""}`;
}
