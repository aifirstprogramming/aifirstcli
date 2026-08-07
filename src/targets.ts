/**
 * The release build matrix.
 *
 * Pure data with no side effects, so the build script, the tests, and anything
 * else can import it without triggering a compile.
 *
 * Asset names here are the contract shared with `src/platform.ts` (which picks
 * one for `aifirst update`) and `install/install.sh` (which picks one at install
 * time). `test/platform.test.ts` holds the three in agreement.
 */

export interface BuildTarget {
  /** Bun's --target value. */
  bunTarget: string;
  /** Release asset name. */
  asset: string;
}

export const TARGETS: BuildTarget[] = [
  { bunTarget: "bun-linux-x64", asset: "aifirst-linux-x64" },
  // For x64 CPUs without AVX2, which the default Bun build requires.
  { bunTarget: "bun-linux-x64-baseline", asset: "aifirst-linux-x64-baseline" },
  // Alpine and other musl-libc distributions.
  { bunTarget: "bun-linux-x64-musl", asset: "aifirst-linux-x64-musl" },
  { bunTarget: "bun-linux-arm64", asset: "aifirst-linux-arm64" },
  { bunTarget: "bun-darwin-x64", asset: "aifirst-darwin-x64" },
  { bunTarget: "bun-darwin-arm64", asset: "aifirst-darwin-arm64" },
  { bunTarget: "bun-windows-x64", asset: "aifirst-windows-x64.exe" },
  { bunTarget: "bun-windows-x64-baseline", asset: "aifirst-windows-x64-baseline.exe" },
  { bunTarget: "bun-windows-arm64", asset: "aifirst-windows-arm64.exe" },
];
