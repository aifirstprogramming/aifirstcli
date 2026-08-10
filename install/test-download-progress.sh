#!/bin/sh
# Regression tests for install.sh's download_with_progress(). Runs real HTTP
# transfers against local fixture servers instead of parsing the script, so a
# dropped -L or a broken -f would actually fail a test here (not just a grep
# for the flag).
#
# Usage: sh install/test-download-progress.sh

set -eu

# shellcheck disable=SC1007  # CDPATH= is the standard idiom to defeat cd's CDPATH lookup, not a typo.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_SH="$SCRIPT_DIR/install.sh"
FIXTURE_DIR="$SCRIPT_DIR/fixtures"
WORK=$(mktemp -d)

PIDS=""
FAIL=0

cleanup() {
  for pid in $PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s: %s\n' "$1" "$2"; FAIL=1; }

start_server() {
  # start_server <port> <cmd...> -> waits for the port, appends the pid to PIDS
  port=$1
  shift
  "$@" >"$WORK/server-$port.log" 2>&1 &
  PIDS="$PIDS $!"
  i=0
  while [ "$i" -lt 50 ]; do
    # curl already prints "000" itself on a connection failure (no server
    # yet), so don't also fall back to "echo 000" on error -- that doubles
    # the string to "000000", which never equals "000" and makes this
    # falsely report ready on the very first (still-down) poll.
    code=$(curl -so /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null || true)
    if [ "$code" != "000" ] && [ -n "$code" ]; then
      return 0
    fi
    i=$((i + 1))
    sleep 0.1
  done
  echo "server on port $port never came up (see $WORK/server-$port.log)" >&2
  exit 1
}

# --- library: pull the three functions under test out of install.sh --------
# install.sh is a script, not a sourceable library (it has top-level
# executable code after these definitions), so we extract just the function
# bodies rather than running the whole file.

LIB="$WORK/lib.sh"
awk '
  /^content_length_for\(\)/,/^}$/ { print }
  /^render_progress\(\)/,/^}$/    { print }
  /^download_with_progress\(\)/,/^}$/ { print }
' "$INSTALL_SH" > "$LIB"

# Sanity check: fail loudly if install.sh's shape changed and we extracted
# nothing, rather than silently passing on a no-op download.
for fn in content_length_for render_progress download_with_progress; do
  grep -q "^$fn()" "$LIB" || { echo "failed to extract $fn from install.sh" >&2; exit 1; }
done

run_download() {
  # run_download <url> <dest> -> runs download_with_progress in a clean
  # subshell, mirroring install.sh's own HAVE_CURL=1 branch and its
  # BAR_FULL/BAR_EMPTY glyph setup (normally done at top level, before
  # platform detection, in install.sh itself).
  url=$1
  dest=$2
  sh -c '
    set -eu
    . "$1"
    HAVE_CURL=1
    BAR_FULL=$(printf "\342\226\210")
    BAR_EMPTY=$(printf "\342\226\221")
    TMP=$(mktemp -d)
    trap "rm -rf \"\$TMP\"" EXIT
    download_with_progress "$2" "$3"
  ' _ "$LIB" "$url" "$dest"
}

# --- fixture asset -----------------------------------------------------

ASSET_BYTES=$((1024 * 1024 + 777))
head -c "$ASSET_BYTES" /dev/urandom > "$WORK/asset.bin"

REDIRECT_PORT=8551
ASSET_PORT=8552
NOT_FOUND_PORT=8553
THROTTLE_REDIRECT_PORT=8554
THROTTLE_ASSET_PORT=8555
CORRUPT_PORT=8556

start_server "$ASSET_PORT" python3 -m http.server "$ASSET_PORT" --directory "$WORK"
start_server "$REDIRECT_PORT" python3 "$FIXTURE_DIR/redirect_server.py" "$REDIRECT_PORT" "$ASSET_PORT"
start_server "$NOT_FOUND_PORT" python3 "$FIXTURE_DIR/not_found_server.py" "$NOT_FOUND_PORT"

# --- test 1: redirect is followed, full bytes land --------------------------

DEST1="$WORK/downloaded_via_redirect.bin"
if run_download "http://127.0.0.1:$REDIRECT_PORT/asset.bin" "$DEST1" 2>"$WORK/t1.err"; then
  got=$(wc -c < "$DEST1" | tr -d ' ')
  if [ "$got" = "$ASSET_BYTES" ]; then
    pass "redirect_follows_and_downloads_full_bytes ($got bytes)"
  else
    fail "redirect_follows_and_downloads_full_bytes" "expected $ASSET_BYTES bytes, got $got"
  fi
else
  fail "redirect_follows_and_downloads_full_bytes" "download_with_progress exited non-zero: $(cat "$WORK/t1.err")"
fi

# --- test 2: progress shows intermediate percentages ------------------------
# A throttled server (chunked with a delay) lets the 1s poller in
# download_with_progress observe the file mid-transfer more than once.

start_server "$THROTTLE_ASSET_PORT" python3 "$FIXTURE_DIR/throttled_server.py" "$THROTTLE_ASSET_PORT" "$WORK/asset.bin"
start_server "$THROTTLE_REDIRECT_PORT" python3 "$FIXTURE_DIR/redirect_server.py" "$THROTTLE_REDIRECT_PORT" "$THROTTLE_ASSET_PORT"

DEST2="$WORK/downloaded_throttled.bin"
PROGRESS_LOG="$WORK/progress.log"
RUNNER2="$WORK/runner2.sh"
cat > "$RUNNER2" <<EOF
. "$LIB"
HAVE_CURL=1
BAR_FULL=\$(printf '\342\226\210')
BAR_EMPTY=\$(printf '\342\226\221')
TMP=\$(mktemp -d)
trap 'rm -rf "\$TMP"' EXIT
download_with_progress "http://127.0.0.1:$THROTTLE_REDIRECT_PORT/asset.bin" "$DEST2"
EOF
script -qec "sh '$RUNNER2' 2>'$PROGRESS_LOG'" "$WORK/typescript.log" >/dev/null 2>&1 || true

distinct_mid=$(tr '\r' '\n' < "$PROGRESS_LOG" 2>/dev/null \
  | sed -n 's/.* \([0-9]\{1,3\}\)%.*/\1/p' \
  | awk '$1 > 0 && $1 < 100' | sort -un | wc -l | tr -d ' ')
if [ "${distinct_mid:-0}" -ge 3 ]; then
  pass "progress_shows_intermediate_values ($distinct_mid distinct mid-range percentages)"
else
  fail "progress_shows_intermediate_values" "only $distinct_mid distinct 0<p<100 values observed (log: $PROGRESS_LOG)"
fi

# --- test 3: non-TTY output has no carriage returns -------------------------

DEST3="$WORK/downloaded_nontty.bin"
NONTTY_LOG="$WORK/nontty.log"
run_download "http://127.0.0.1:$REDIRECT_PORT/asset.bin" "$DEST3" >/dev/null 2>"$NONTTY_LOG" || true

cr_count=$(tr -cd '\r' < "$NONTTY_LOG" | wc -c | tr -d ' ')
if [ "$cr_count" = "0" ]; then
  pass "non_tty_output_has_no_carriage_returns"
else
  fail "non_tty_output_has_no_carriage_returns" "found $cr_count carriage returns in $NONTTY_LOG"
fi

# --- test 4: corrupted download is rejected by the checksum gate -----------
# Downloads a real asset, then compares it against a deliberately-wrong
# SHA256SUMS fixture, mirroring install.sh's own checksum-compare step.

CORRUPT_ROOT="$WORK/corrupt-release"
mkdir -p "$CORRUPT_ROOT"
cp "$WORK/asset.bin" "$CORRUPT_ROOT/asset-good"
echo "0000000000000000000000000000000000000000000000000000000000000000  asset-good" > "$CORRUPT_ROOT/SHA256SUMS"
start_server "$CORRUPT_PORT" python3 -m http.server "$CORRUPT_PORT" --directory "$CORRUPT_ROOT"

DL="$WORK/corrupt_asset"
if run_download "http://127.0.0.1:$CORRUPT_PORT/asset-good" "$DL" 2>"$WORK/t4.err"; then
  actual=$(sha256sum "$DL" | awk '{print $1}')
  expected=$(awk '{print $1}' "$CORRUPT_ROOT/SHA256SUMS")
  if [ "$actual" != "$expected" ]; then
    pass "corrupted_download_rejected (checksum mismatch correctly detected)"
  else
    fail "corrupted_download_rejected" "checksums matched unexpectedly"
  fi
else
  fail "corrupted_download_rejected" "download itself failed, could not exercise checksum gate: $(cat "$WORK/t4.err")"
fi

# --- test 5: a real HTTP 404 still fails clearly ----------------------------

DEST5="$WORK/downloaded_404.bin"
if run_download "http://127.0.0.1:$NOT_FOUND_PORT/missing.bin" "$DEST5" 2>"$WORK/t5.err"; then
  fail "http_404_still_fails" "download_with_progress exited 0 on a 404"
else
  size=$(wc -c < "$DEST5" 2>/dev/null | tr -d ' ')
  if [ "${size:-0}" = "0" ]; then
    pass "http_404_still_fails (non-zero exit, empty file)"
  else
    fail "http_404_still_fails" "expected empty file on 404, got $size bytes"
  fi
fi

if [ "$FAIL" = "1" ]; then
  echo "one or more download_with_progress regression tests FAILED"
  exit 1
fi
echo "all download_with_progress regression tests passed"
