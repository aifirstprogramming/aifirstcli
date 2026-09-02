import type { BuildTarget } from "../src/targets";

export const WINDOWS_PRODUCT_NAME = "AI First CLI";
export const WINDOWS_COMPANY_NAME = "AI First Programming";
export const WINDOWS_DESCRIPTION = "Companion CLI for the AI First Programming book series";
export const WINDOWS_COPYRIGHT = "Copyright (c) 2026 Stephen Chin, Cassandra Chin, and Jennifer Reif";

type HostPlatform = "linux" | "darwin" | "win32";

function targetOs(target: BuildTarget): "linux" | "darwin" | "windows" {
  if (target.bunTarget.startsWith("bun-linux-")) return "linux";
  if (target.bunTarget.startsWith("bun-darwin-")) return "darwin";
  if (target.bunTarget.startsWith("bun-windows-")) return "windows";
  throw new Error(`Unsupported Bun target: ${target.bunTarget}`);
}

function hostOs(platform: HostPlatform): "linux" | "darwin" | "windows" {
  return platform === "win32" ? "windows" : platform;
}

export function windowsVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`package version must be semantic X.Y.Z: ${version}`);
  return `${match[1]}.${match[2]}.${match[3]}.0`;
}

export function selectBuildTargets(
  argv: string[],
  platform: HostPlatform,
  arch: string,
  targets: BuildTarget[],
): BuildTarget[] {
  if (argv.includes("--all")) {
    throw new Error("--all is no longer supported; build each OS family on its native runner");
  }

  if (argv.includes("--local")) {
    const cpu = arch === "arm64" ? "arm64" : "x64";
    const wanted = `bun-${hostOs(platform)}-${cpu}`;
    const found = targets.find((target) => target.bunTarget === wanted);
    if (!found) throw new Error(`No build target for ${platform}/${arch}`);
    return [found];
  }

  const explicit = argv.indexOf("--target");
  if (explicit >= 0) {
    const wanted = argv[explicit + 1];
    const found = targets.find((target) => target.bunTarget === wanted || target.asset === wanted);
    if (!found) {
      throw new Error(`Unknown target "${wanted}". Known: ${targets.map((target) => target.bunTarget).join(", ")}`);
    }
    if (targetOs(found) === "windows" && platform !== "win32") {
      throw new Error("Windows release targets must be built on Windows so PE metadata can be applied");
    }
    return [found];
  }

  const os = hostOs(platform);
  return targets.filter((target) => targetOs(target) === os);
}

export function buildArgs(
  target: BuildTarget,
  platform: HostPlatform,
  version: string,
  entry: string,
  outfile: string,
): string[] {
  const args = ["build", "--compile", "--minify", `--target=${target.bunTarget}`];

  if (target.bunTarget.startsWith("bun-linux-")) {
    const libc = target.bunTarget.endsWith("-musl") ? "musl" : "glibc";
    args.push(`--define=process.env.OPENTUI_LIBC=${JSON.stringify(libc)}`);
  }

  if (targetOs(target) === "windows") {
    if (platform !== "win32") {
      throw new Error("Windows release targets must be built on Windows so PE metadata can be applied");
    }
    args.push(
      `--windows-title=${WINDOWS_PRODUCT_NAME}`,
      `--windows-publisher=${WINDOWS_COMPANY_NAME}`,
      `--windows-version=${windowsVersion(version)}`,
      `--windows-description=${WINDOWS_DESCRIPTION}`,
      `--windows-copyright=${WINDOWS_COPYRIGHT}`,
    );
  }

  args.push(entry, "--outfile", outfile);
  return args;
}
