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
  DL_PID=$!

  dl_tty=0
  [ -t 2 ] && dl_tty=1
  dl_interval=1
  [ "$dl_tty" = "1" ] || dl_interval=2

  while kill -0 "$DL_PID" 2>/dev/null; do
    sleep "$dl_interval"
    # The download's own cleanup (or an external actor) can remove $dl_dest
    # out from under us; without this the loop spins forever on a bash
    # redirection error instead of stopping.
    [ -e "$dl_dest" ] || break
    dl_done=$(wc -c < "$dl_dest" 2>/dev/null | tr -d ' ')
    [ -n "$dl_done" ] || dl_done=0
    render_progress "$dl_done" "$dl_total" "$dl_tty"
  done

  dl_status=0
  wait "$DL_PID" || dl_status=$?
  DL_PID=""

  dl_done=0
  [ -e "$dl_dest" ] && dl_done=$(wc -c < "$dl_dest" 2>/dev/null | tr -d ' ')
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
DL_PID=""

# Kill the backgrounded downloader on interrupt: a non-interactive shell makes
# bash ignore SIGINT for background children, so Ctrl-C alone never reaches curl.
cleanup() {
  [ -n "${DL_PID:-}" ] && kill "$DL_PID" 2>/dev/null
  rm -rf "$TMP"
}
# Re-raise SIGINT after cleanup so the calling shell sees a real signal
# termination (exit 130), not a plain nonzero exit.
trap 'cleanup; trap - INT; kill -INT $$' INT
trap cleanup EXIT TERM

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
  *":$INSTALL_DIR:"*) ;;
  *)
    shell_name=$(basename "${SHELL:-sh}")
    rc_path=""
    path_line=""
    case "$shell_name" in
      zsh)
        rc_path="$HOME/.zshrc"
        path_line="export PATH=\"$INSTALL_DIR:\$PATH\""
        ;;
      bash)
        if [ "$OS" = "darwin" ]; then rc_path="$HOME/.bash_profile"; else rc_path="$HOME/.bashrc"; fi
        path_line="export PATH=\"$INSTALL_DIR:\$PATH\""
        ;;
      fish)
        rc_path="$HOME/.config/fish/config.fish"
        path_line="fish_add_path \"$INSTALL_DIR\""
        ;;
    esac

    if [ -n "$rc_path" ]; then
      mkdir -p "$(dirname "$rc_path")"
      if ! grep -Fq "$path_line" "$rc_path" 2>/dev/null; then
        {
          printf '\n# Added by aifirst\n'
          printf '%s\n' "$path_line"
        } >> "$rc_path"
        info "Added $INSTALL_DIR to PATH in $rc_path."
      fi
    else
      info "Could not identify your shell profile; add $INSTALL_DIR to PATH later."
    fi
    PATH="$INSTALL_DIR:$PATH"
    export PATH
    ;;
esac

# --- first setup -----------------------------------------------------------

if [ "${AIFIRST_SKIP_SETUP:-}" != "1" ]; then
  if ( : </dev/tty ) 2>/dev/null; then
    say ""
    "$INSTALL_DIR/aifirst" init </dev/tty || info "Setup was not completed; run aifirst later to resume."
  else
    info "Interactive setup skipped because no terminal is attached."
  fi
fi

say ""
say "  ${DIM}Docs: $DOCS${RESET}"
say ""
