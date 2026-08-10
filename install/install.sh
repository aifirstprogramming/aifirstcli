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
  HAVE_CURL=1
  DOWNLOAD="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  HAVE_CURL=0
  DOWNLOAD="wget -qO-"
else
  die "need curl or wget to download aifirst"
fi

# --- download progress -------------------------------------------------
#
# curl's and wget's own meters were measured and rejected (see the plan at
# docs/ai/plans/2026-08-09-installer-progress.md): they look different from
# each other, and curl's --progress-bar still writes carriage returns even
# when stderr is redirected to a file. Instead we render the same bar()
# style the CLI itself uses (src/output.ts), by hand, in shell.
#
# Progress always goes to stderr (stdout is the piped script). [ -t 2 ], not
# [ -t 1 ], decides whether we redraw one line or print periodic plain ones.

if [ "${AIFIRST_ASCII:-}" = "1" ]; then
  BAR_FULL="#"
  BAR_EMPTY="."
else
  BAR_FULL=$(printf '\342\226\210')
  BAR_EMPTY=$(printf '\342\226\221')
fi

# Best-effort Content-Length lookup so the bar can show a percentage. Prints
# nothing (not an error) when it can't be determined; the download still
# proceeds and renders a plain byte count instead of a fraction.
content_length_for() {
  if [ "$HAVE_CURL" = "1" ]; then
    curl -fsSL -I "$1" 2>/dev/null | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: *\([0-9][0-9]*\)/\1/p' | tail -n1
  else
    wget --spider -S "$1" 2>&1 | tr -d '\r' | sed -n 's/^[[:space:]]*Content-[Ll]ength: *\([0-9][0-9]*\)/\1/p' | tail -n1
  fi
}

# One progress line: $1 = bytes so far, $2 = total bytes (0 if unknown),
# $3 = "1" to redraw the current line with \r, "0" to print a fresh line.
# All the arithmetic runs in awk so a 92MB transfer never risks overflowing
# 32-bit shell integer math.
render_progress() {
  info_line=$(awk -v d="$1" -v t="$2" -v w=20 -v full="$BAR_FULL" -v empty="$BAR_EMPTY" '
    BEGIN {
      if (t > 0) {
        p = int(d * 100 / t)
        if (p > 100) p = 100
      } else {
        p = 0
      }
      filled = int(p * w / 100)
      bar = ""
      for (i = 0; i < filled; i++) bar = bar full
      for (i = filled; i < w; i++) bar = bar empty
      done_mb = d / 1048576
      if (t > 0) {
        total_mb = t / 1048576
        printf "%s %3d%%   %.1f / %.1f MB", bar, p, done_mb, total_mb
      } else {
        printf "%s   %.1f MB", bar, done_mb
      }
    }')

  if [ "$3" = "1" ]; then
    printf '\r  %s' "$info_line" >&2
  else
    printf '  %s\n' "$info_line" >&2
  fi
}

# Downloads $1 into $2 in the background while polling its growing size to
# drive render_progress. Exit status matches the downloader's, so callers
# keep the existing -f/--fail semantics: a 404 still fails the install.
download_with_progress() {
  dl_url=$1
  dl_dest=$2

  dl_total=$(content_length_for "$dl_url")
  case "$dl_total" in '' | *[!0-9]*) dl_total=0 ;; esac

  : > "$dl_dest"
  if [ "$HAVE_CURL" = "1" ]; then
    # -L: GitHub release URLs redirect; without it curl silently writes an empty body.
    curl -fsSL -o "$dl_dest" "$dl_url" 2>"$TMP/dl.err" &
  else
    wget -q -O "$dl_dest" "$dl_url" 2>"$TMP/dl.err" &
  fi
  dl_pid=$!

  dl_tty=0
  [ -t 2 ] && dl_tty=1
  dl_interval=1
  [ "$dl_tty" = "1" ] || dl_interval=2

  while kill -0 "$dl_pid" 2>/dev/null; do
    sleep "$dl_interval"
    dl_done=$(wc -c < "$dl_dest" 2>/dev/null | tr -d ' ')
    [ -n "$dl_done" ] || dl_done=0
    render_progress "$dl_done" "$dl_total" "$dl_tty"
  done

  dl_status=0
  wait "$dl_pid" || dl_status=$?

  dl_done=$(wc -c < "$dl_dest" 2>/dev/null | tr -d ' ')
  [ -n "$dl_done" ] || dl_done=0
  render_progress "$dl_done" "$dl_total" "$dl_tty"
  [ "$dl_tty" = "1" ] && printf '\n' >&2

  if [ "$dl_status" -ne 0 ] && [ -s "$TMP/dl.err" ]; then
    tr -d '\r' < "$TMP/dl.err" >&2
  fi

  return "$dl_status"
}

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

download_with_progress "$BASE/$ASSET" "$TMP/$ASSET" \
  || die "could not download $ASSET from $TAG.
    That build may not exist for this platform. See $DOCS"

# Refuse to install an unverified binary: this file is about to be executed.
if download_with_progress "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"; then
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
