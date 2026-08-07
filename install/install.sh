#!/bin/sh
# AI First CLI installer.
#
#   curl -fsSL https://aifirstprogramming.com/install.sh | bash
#
# Environment overrides:
#   AIFIRST_VERSION      version to install (default: latest release)
#   AIFIRST_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
#
# POSIX sh on purpose: this runs on whatever a reader happens to have, including
# minimal containers and macOS's older shells.

set -eu

REPO="aifirstprogramming/aifirstcli"
DOCS="https://aifirstprogramming.com"
INSTALL_DIR="${AIFIRST_INSTALL_DIR:-$HOME/.local/bin}"

# --- output ----------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); RESET=$(printf '\033[0m')
else
  BOLD=''; DIM=''; RED=''; GREEN=''; RESET=''
fi

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '%s\n' "${RED}error${RESET} $*" >&2; exit 1; }

# --- prerequisites ---------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
  DOWNLOAD="curl -fsSL"
  DOWNLOAD_TO="curl -fsSL -o"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOAD="wget -qO-"
  DOWNLOAD_TO="wget -qO"
else
  die "need curl or wget to download aifirst"
fi

# --- detect platform -------------------------------------------------------

os=$(uname -s)
case "$os" in
  Linux)   OS="linux" ;;
  Darwin)  OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    die "this script is for macOS and Linux. On Windows, run in PowerShell:
    irm $DOCS/install.ps1 | iex" ;;
  *) die "unsupported operating system: $os" ;;
esac

machine=$(uname -m)
case "$machine" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "unsupported architecture: $machine" ;;
esac

# Variant selection. This logic is mirrored in src/platform.ts so that
# `aifirst update` keeps a machine on the variant that actually runs here.
VARIANT=""
if [ "$OS" = "linux" ]; then
  # musl (Alpine and friends) can't run the glibc build at all.
  if [ -f /etc/alpine-release ] || ls /lib/ld-musl-* >/dev/null 2>&1; then
    VARIANT="-musl"
  elif [ "$ARCH" = "x64" ] && ! grep -q '^flags.*\bavx2\b' /proc/cpuinfo 2>/dev/null; then
    # Bun's default x64 build needs AVX2; older CPUs get an illegal instruction
    # crash on first run, which looks to a beginner like a broken download.
    VARIANT="-baseline"
  fi
fi

ASSET="aifirst-${OS}-${ARCH}${VARIANT}"

# --- resolve version -------------------------------------------------------

VERSION="${AIFIRST_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION=$($DOWNLOAD "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1) || true
  [ -n "$VERSION" ] || die "could not determine the latest version. Check your connection, or set AIFIRST_VERSION."
fi
case "$VERSION" in v*) TAG="$VERSION" ;; *) TAG="v$VERSION" ;; esac

BASE="https://github.com/$REPO/releases/download/$TAG"

say ""
say "  ${BOLD}Installing aifirst${RESET} ${DIM}$TAG${RESET}"
info "${DIM}$ASSET → $INSTALL_DIR${RESET}"
say ""

# --- download and verify ---------------------------------------------------

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t aifirst)
# shellcheck disable=SC2064
trap "rm -rf '$TMP'" EXIT INT TERM

$DOWNLOAD_TO "$TMP/$ASSET" "$BASE/$ASSET" \
  || die "could not download $ASSET from $TAG.
    That build may not exist for this platform. See $DOCS"

# Refuse to install an unverified binary: this file is about to be executed.
if $DOWNLOAD_TO "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" 2>/dev/null; then
  expected=$(grep " \*\{0,1\}$ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}' | head -n1)
  if [ -z "$expected" ]; then
    die "$ASSET is not listed in SHA256SUMS; refusing to install"
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$TMP/$ASSET" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
  else
    actual=""
    info "${DIM}no sha256 tool available; skipping checksum verification${RESET}"
  fi

  if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $ASSET
    expected $expected
    actual   $actual"
  fi
else
  die "could not download SHA256SUMS; refusing to install an unverified binary"
fi

# --- install ---------------------------------------------------------------

mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR"
chmod +x "$TMP/$ASSET"

# mv across filesystems can fail; fall back to cp.
mv "$TMP/$ASSET" "$INSTALL_DIR/aifirst" 2>/dev/null \
  || cp "$TMP/$ASSET" "$INSTALL_DIR/aifirst" \
  || die "could not write to $INSTALL_DIR. Set AIFIRST_INSTALL_DIR to somewhere writable."

installed_version=$("$INSTALL_DIR/aifirst" --version 2>/dev/null) \
  || die "the installed binary would not run. Please report this at
    https://github.com/$REPO/issues with your OS and CPU."

say "  ${GREEN}✔${RESET} aifirst ${BOLD}$installed_version${RESET} installed"
say ""

# --- PATH ------------------------------------------------------------------

case ":${PATH}:" in
  *":$INSTALL_DIR:"*)
    say "  Next:"
    say "    ${BOLD}aifirst init${RESET}    ${DIM}set up your AI tools${RESET}"
    say "    ${BOLD}aifirst next${RESET}    ${DIM}your first exercise${RESET}"
    ;;
  *)
    # Name the shell's own rc file rather than a generic instruction; a reader on
    # chapter 1 should not have to work out which file applies to them.
    shell_name=$(basename "${SHELL:-sh}")

    # The tildes below are literal text printed for the reader to copy, not paths
    # this script opens, so they must not expand.
    # shellcheck disable=SC2088
    case "$shell_name" in
      zsh)  rc="~/.zshrc" ;;
      bash)
        if [ "$OS" = "darwin" ]; then rc="~/.bash_profile"; else rc="~/.bashrc"; fi ;;
      fish) rc="~/.config/fish/config.fish" ;;
      *)    rc="your shell profile" ;;
    esac

    say "  ${BOLD}$INSTALL_DIR is not on your PATH.${RESET}"
    say ""
    if [ "$shell_name" = "fish" ]; then
      say "    Add this line to $rc:"
      say "      ${DIM}fish_add_path $INSTALL_DIR${RESET}"
    else
      say "    Add this line to $rc:"
      say "      ${DIM}export PATH=\"$INSTALL_DIR:\$PATH\"${RESET}"
    fi
    say ""
    say "    Then open a new terminal and run: ${BOLD}aifirst init${RESET}"
    ;;
esac

say ""
say "  ${DIM}Docs: $DOCS${RESET}"
say ""
