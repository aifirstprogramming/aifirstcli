/**
 * `aifirst update [--content] [--check]`.
 *
 * Two independent things can move: the binary, and the book content. Content is
 * separated deliberately — a typo fix in a printed example should reach readers
 * without shipping nine platform binaries, and a learner on a locked-down machine
 * can refresh content without being able to replace an executable.
 *
 * A downloaded content pack is validated through the shared loader before it is
 * put in place, and only ever *added* alongside the embedded one. A bad download
 * can therefore never leave a learner unable to see their exercises.
 */

import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadFromDirectory } from "@aifirst/content";
import type { Args } from "../cli";
import { boolFlag, formatFlag } from "../cli";
import { compareVersions, findLatestPack, resolveContent } from "../content";
import { EMBEDDED_PACK_VERSION } from "../content";
import { read as readConfig } from "../config";
import { contentDir } from "../paths";
import { isWindows } from "../paths";
import { CliError, bar, bold, dim, glyph, green, json, out, yellow } from "../output";
import type { Format } from "../output";
import { CONTENT_REPO, INSTALL_HOST, REPO, VERSION } from "../version";
import { run } from "../agents/util";
import { assetNameFor, currentTarget } from "../platform";

interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

async function latestRelease(repo: string): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `aifirst/${VERSION}` },
  });
  if (!res.ok) {
    throw new CliError(
      `Could not reach GitHub (${res.status})`,
      "network",
      res.status === 404 ? `No releases published for ${repo} yet.` : "Check your connection and retry.",
    );
  }
  return (await res.json()) as Release;
}

const stripV = (tag: string) => tag.replace(/^v/, "");

/**
 * Streams a download, rendering `bar()` against Content-Length as bytes
 * arrive, so `aifirst update` never goes quiet the way the buffered
 * `arrayBuffer()`/`text()` calls it replaces did.
 *
 * On a TTY the line redraws in place; otherwise (CI, output piped to a
 * file) it prints periodic plain lines instead, matching the installer's
 * non-interactive behaviour. Bun's `Response.body` is always a
 * `ReadableStream` for a real network response, but tests can still hand
 * back a `Response` with no body (e.g. `new Response(null)`), so that case
 * falls back to a single buffered read rather than throwing.
 */
export async function fetchWithProgress(url: string, init: RequestInit, label: string): Promise<Uint8Array> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new CliError(`Failed to download ${label} (${res.status})`, "network");
  }

  const reader = res.body?.getReader();
  if (!reader) {
    return new Uint8Array(await res.arrayBuffer());
  }

  const totalHeader = Number(res.headers.get("content-length"));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;
  const isTTY = Boolean(process.stderr.isTTY);
  const renderIntervalMs = isTTY ? 100 : 2000;

  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastRender = 0;

  const render = (final: boolean) => {
    const now = Date.now();
    if (!final && now - lastRender < renderIntervalMs) return;
    lastRender = now;
    const doneMb = (received / 1_048_576).toFixed(1);
    const line =
      total !== undefined
        ? `  ${bar(received / total)} ${String(Math.min(100, Math.round((received / total) * 100))).padStart(3)}%   ${doneMb} / ${(total / 1_048_576).toFixed(1)} MB`
        : `  ${bar(0)}   ${doneMb} MB`;
    if (isTTY) {
      process.stderr.write(`\r${line}`);
      if (final) process.stderr.write("\n");
    } else {
      process.stderr.write(`${line}\n`);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      render(false);
    }
  }
  render(true);

  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function update(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const checkOnly = boolFlag(args, "check");
  const contentOnly = boolFlag(args, "content");

  if (contentOnly) return updateContent(format, checkOnly);
  return updateBinary(format, checkOnly);
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

async function updateContent(format: Format, checkOnly: boolean): Promise<void> {
  const current = resolveContent();
  const release = await latestRelease(CONTENT_REPO);
  const available = stripV(release.tag_name);
  const newer = compareVersions(available, current.version) > 0;

  if (format === "json" && checkOnly) {
    json({ current: current.version, available, newer });
    if (newer) process.exitCode = 1;
    return;
  }
  if (checkOnly) {
    out();
    out(
      newer
        ? `  ${yellow(glyph.todo)} content pack ${bold(available)} available ${dim(`(you have ${current.version})`)}`
        : `  ${green(glyph.done)} content pack ${bold(current.version)} is current`,
    );
    out();
    if (newer) process.exitCode = 1;
    return;
  }

  if (!newer) {
    if (format === "json") json({ updated: false, version: current.version });
    else {
      out();
      out(`  ${green(glyph.done)} content pack ${bold(current.version)} is already current`);
      out();
    }
    return;
  }

  const books = release.assets.filter((a) => a.name.toLowerCase().endsWith(".json"));
  if (books.length === 0) {
    throw new CliError(
      `Release ${release.tag_name} has no book files attached`,
      "bad_release",
      "This is a publishing problem, not a local one — please report it.",
    );
  }

  // Stage into a temp directory and validate before publishing, so a partial or
  // corrupt download is never visible to the loader.
  const staging = mkdtempSync(join(tmpdir(), "aifirst-content-"));
  const stagedBooks = join(staging, "books");
  mkdirSync(stagedBooks, { recursive: true });

  try {
    for (const asset of books) {
      const bytes = await fetchWithProgress(
        asset.browser_download_url,
        { headers: { "User-Agent": `aifirst/${VERSION}` } },
        asset.name,
      );
      writeFileSync(join(stagedBooks, asset.name), bytes);
    }

    // The real gate: it must load through the same strict loader the CLI uses.
    const loaded = loadFromDirectory(stagedBooks, { version: available });
    if (loaded.examples.length === 0) {
      throw new CliError("Downloaded pack contains no exercises", "bad_release");
    }

    const dest = join(contentDir(), available);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(staging, dest);

    if (format === "json") {
      json({ updated: true, from: current.version, to: available, exercises: loaded.examples.length });
      return;
    }
    out();
    out(`  ${green(glyph.done)} content pack ${bold(available)} installed ${dim(`(was ${current.version})`)}`);
    out(dim(`      ${loaded.examples.length} exercises, ${loaded.books.length} book(s)`));
    out(dim(`      embedded pack ${EMBEDDED_PACK_VERSION} kept as a fallback`));
    out();
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Binary
// ---------------------------------------------------------------------------

/**
 * Release asset for this machine, including the baseline/musl variant.
 *
 * Resolving the variant here rather than assuming the plain build matters: a
 * learner on a pre-AVX2 CPU installed the `-baseline` artifact, and handing them
 * the plain one on update would replace a working CLI with one that crashes.
 */
export function assetName(): string | undefined {
  const target = currentTarget();
  return target ? assetNameFor(target) : undefined;
}

async function updateBinary(format: Format, checkOnly: boolean): Promise<void> {
  const release = await latestRelease(REPO);
  const available = stripV(release.tag_name);
  const newer = compareVersions(available, VERSION) > 0;

  if (format === "json" && checkOnly) {
    json({ current: VERSION, available, newer });
    if (newer) process.exitCode = 1;
    return;
  }
  if (checkOnly) {
    out();
    out(
      newer
        ? `  ${yellow(glyph.todo)} aifirst ${bold(available)} available ${dim(`(you have ${VERSION})`)}`
        : `  ${green(glyph.done)} aifirst ${bold(VERSION)} is current`,
    );
    out();
    if (newer) process.exitCode = 1;
    return;
  }

  if (!newer) {
    if (format === "json") json({ updated: false, version: VERSION });
    else {
      out();
      out(`  ${green(glyph.done)} aifirst ${bold(VERSION)} is already current`);
      out(dim(`      ${glyph.arrow} aifirst update --content    check for new book content`));
      out();
    }
    return;
  }

  // Windows holds an open handle on a running executable, so it cannot be
  // replaced in place. Rather than leave a half-updated install, say so and point
  // at the installer, which handles it.
  if (isWindows) {
    throw new CliError(
      `aifirst ${available} is available, but a running executable can't replace itself on Windows`,
      "unsupported",
      `Run: irm ${INSTALL_HOST}/install.ps1 | iex`,
    );
  }

  const wanted = assetName();
  const asset = wanted ? release.assets.find((a) => a.name === wanted) : undefined;
  if (!asset) {
    throw new CliError(
      `No build for ${process.platform}/${process.arch} in release ${release.tag_name}`,
      "unsupported_platform",
      `Reinstall with: curl -fsSL ${INSTALL_HOST}/install.sh | bash`,
    );
  }

  const [binary, sums] = await Promise.all([
    fetchWithProgress(
      asset.browser_download_url,
      { headers: { "User-Agent": `aifirst/${VERSION}` } },
      asset.name,
    ),
    (async () => {
      const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
      if (!sumsAsset) return undefined;
      const r = await fetch(sumsAsset.browser_download_url, {
        headers: { "User-Agent": `aifirst/${VERSION}` },
      });
      return r.ok ? await r.text() : undefined;
    })(),
  ]);

  // Refuse an unverified binary: this file is about to be executed on a
  // learner's machine, and a silent "couldn't check" is worse than an error.
  if (!sums) {
    throw new CliError(
      `Release ${release.tag_name} has no SHA256SUMS to verify against`,
      "unverified",
      `Reinstall with: curl -fsSL ${INSTALL_HOST}/install.sh | bash`,
    );
  }
  const expected = sums
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, "") === asset.name)?.[0];
  const actual = new Bun.CryptoHasher("sha256").update(new Uint8Array(binary)).digest("hex");
  if (!expected) {
    throw new CliError(`${asset.name} is not listed in SHA256SUMS`, "unverified");
  }
  if (expected !== actual) {
    throw new CliError(
      `Checksum mismatch for ${asset.name}`,
      "checksum_mismatch",
      "Downloaded file does not match the published checksum; not installing it.",
    );
  }

  const target = process.execPath;
  const tmp = `${target}.new`;
  writeFileSync(tmp, new Uint8Array(binary));
  chmodSync(tmp, 0o755);
  // rename() over the running binary is safe on unix: the open inode survives
  // until this process exits.
  renameSync(tmp, target);

  // Skill bundles carry the CLI version, so refresh them with the *new* binary.
  // This also refreshes the command allowlist, which is why an upgrade no longer
  // leaves a reader approving every command. A learner who declined stays declined.
  const refreshArgs = ["skill", "install", "--format", "json"];
  if (readConfig().permissionsOptOut) refreshArgs.push("--no-permissions");
  const refresh = await run(target, refreshArgs, 30_000);

  if (format === "json") {
    json({ updated: true, from: VERSION, to: available, skillsRefreshed: refresh.ok });
    return;
  }
  out();
  out(`  ${green(glyph.done)} updated to aifirst ${bold(available)} ${dim(`(was ${VERSION})`)}`);
  out(dim(`      ${refresh.ok ? "refreshed installed skills" : "run aifirst skill install to refresh skills"}`));
  out();
}
