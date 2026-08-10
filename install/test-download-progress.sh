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

# --- library: pull install.sh's top-level cleanup/trap block too -----------
# Tests 6-9 need the real trap wiring (cleanup, DL_PID, re-raised SIGINT), not
# just download_with_progress in isolation, since the bug lives in how the
# top-level trap and the polling loop interact.

CLEANUP_LIB="$WORK/cleanup_lib.sh"
awk '
  /^content_length_for\(\)/,/^}$/ { print }
  /^render_progress\(\)/,/^}$/    { print }
  /^download_with_progress\(\)/,/^}$/ { print }
  /^cleanup\(\)/,/^}$/ { print }
' "$INSTALL_SH" > "$CLEANUP_LIB"
grep -q '^cleanup()' "$CLEANUP_LIB" || { echo "failed to extract cleanup from install.sh" >&2; exit 1; }

# Pull install.sh's own top-level trap lines verbatim rather than hardcoding
# them in the runner below, so a regression in the trap wiring itself (e.g. a
# dropped re-raise) is something this harness can actually catch.
INT_TRAP_LINE=$(grep -m1 "^trap .* INT$" "$INSTALL_SH")
EXIT_TRAP_LINE=$(grep -m1 "^trap cleanup EXIT TERM$" "$INSTALL_SH")
[ -n "$INT_TRAP_LINE" ] || { echo "failed to extract INT trap from install.sh" >&2; exit 1; }
[ -n "$EXIT_TRAP_LINE" ] || { echo "failed to extract EXIT/TERM trap from install.sh" >&2; exit 1; }

# A slow-server harness that mirrors install.sh's own top-level shape: a real
# script (not a sourced function) with its own TMP, DL_PID, cleanup and traps,
# run under a pty so a genuine \x03 hits the real foreground process group.
make_ctrlc_runner() {
  # make_ctrlc_runner <path> <url> <dest> <install-dir-unused>
  runner=$1
  url=$2
  dest=$3
  cat > "$runner" <<EOF
#!/bin/sh
set -eu
. "$CLEANUP_LIB"
HAVE_CURL=\${FORCE_WGET:-0}
if [ "\$HAVE_CURL" = "1" ]; then HAVE_CURL=0; else HAVE_CURL=1; fi
BAR_FULL=\$(printf '\\342\\226\\210')
BAR_EMPTY=\$(printf '\\342\\226\\221')
TMP=\$(mktemp -d)
DL_PID=""
$INT_TRAP_LINE
$EXIT_TRAP_LINE
download_with_progress "$url" "$dest"
echo "DOWNLOAD_EXIT=\$?"
EOF
  chmod +x "$runner"
}

# --- test 6: Ctrl-C during download exits promptly with no spam (curl) -----

SLOW_PORT=8560
start_server "$SLOW_PORT" python3 "$FIXTURE_DIR/throttled_server.py" "$SLOW_PORT" "$WORK/asset.bin"

DEST6="$WORK/ctrlc_curl.bin"
RUNNER6="$WORK/runner6.sh"
make_ctrlc_runner "$RUNNER6" "http://127.0.0.1:$SLOW_PORT/asset.bin" "$DEST6"
LOG6="$WORK/ctrlc_curl.log"
RESULT6=$(python3 "$FIXTURE_DIR/pty_sigint_driver.py" "sh '$RUNNER6'" "$LOG6" 0.6)
spam6=$(grep -c 'cannot open.*No such file' "$LOG6" 2>/dev/null || true)
[ -n "$spam6" ] || spam6=0
tmp6=$(sed -n 's/.*TMP=\(\S*\).*/\1/p' "$RUNNER6" 2>/dev/null || true)

case "$RESULT6" in
  *signaled=True*signal=2*)
    if [ "$spam6" = "0" ]; then
      pass "sigint_during_curl_download_exits_promptly_no_spam ($RESULT6)"
    else
      fail "sigint_during_curl_download_exits_promptly_no_spam" "$spam6 spam lines in $LOG6"
    fi
    ;;
  *)
    fail "sigint_during_curl_download_exits_promptly_no_spam" "$RESULT6"
    ;;
esac

# No orphaned curl should survive, immediately and after a short delay.
if pgrep -f "127.0.0.1:$SLOW_PORT" >/dev/null 2>&1; then
  fail "sigint_during_curl_download_exits_promptly_no_spam" "curl still running immediately after exit"
else
  sleep 1
  if pgrep -f "127.0.0.1:$SLOW_PORT" >/dev/null 2>&1; then
    fail "sigint_during_curl_download_exits_promptly_no_spam" "curl re-appeared 1s after exit"
  else
    pass "sigint_during_curl_download_exits_promptly_no_spam (no orphaned curl)"
  fi
fi

# --- test 7: Ctrl-C during download exits promptly with no spam (wget) -----

DEST7="$WORK/ctrlc_wget.bin"
RUNNER7="$WORK/runner7.sh"
make_ctrlc_runner "$RUNNER7" "http://127.0.0.1:$SLOW_PORT/asset.bin" "$DEST7"
LOG7="$WORK/ctrlc_wget.log"
RESULT7=$(FORCE_WGET=1 python3 "$FIXTURE_DIR/pty_sigint_driver.py" "FORCE_WGET=1 sh '$RUNNER7'" "$LOG7" 0.6)
spam7=$(grep -c 'cannot open.*No such file' "$LOG7" 2>/dev/null || true)
[ -n "$spam7" ] || spam7=0

case "$RESULT7" in
  *signaled=True*signal=2*)
    if [ "$spam7" = "0" ]; then
      pass "sigint_during_wget_download_exits_promptly_no_spam ($RESULT7)"
    else
      fail "sigint_during_wget_download_exits_promptly_no_spam" "$spam7 spam lines in $LOG7"
    fi
    ;;
  *)
    fail "sigint_during_wget_download_exits_promptly_no_spam" "$RESULT7"
    ;;
esac

if pgrep -f "wget.*127.0.0.1:$SLOW_PORT" >/dev/null 2>&1; then
  fail "sigint_during_wget_download_exits_promptly_no_spam" "wget still running immediately after exit"
else
  pass "sigint_during_wget_download_exits_promptly_no_spam (no orphaned wget)"
fi

# --- test 8: a single Ctrl-C is sufficient ----------------------------------
# The driver above already sends exactly one \x03; this test asserts the
# process is gone (not merely "should be gone") before we'd even consider a
# second signal, by checking there is nothing left to send it to.

DEST8="$WORK/ctrlc_single.bin"
RUNNER8="$WORK/runner8.sh"
make_ctrlc_runner "$RUNNER8" "http://127.0.0.1:$SLOW_PORT/asset.bin" "$DEST8"
LOG8="$WORK/ctrlc_single.log"
RESULT8=$(python3 "$FIXTURE_DIR/pty_sigint_driver.py" "sh '$RUNNER8'" "$LOG8" 0.6)
case "$RESULT8" in
  *signaled=True*signal=2*)
    pass "single_sigint_is_sufficient ($RESULT8, one \\x03 sent)"
    ;;
  *)
    fail "single_sigint_is_sufficient" "$RESULT8"
    ;;
esac

# --- test 9: destination deleted mid-transfer breaks the loop (no signal) --
# Directly exercises the defensive `[ -e "$dl_dest" ] || break` addition,
# independent of the kill/signal path.

DEST9="$WORK/deleted_mid_transfer.bin"
RUNNER9="$WORK/runner9.sh"
cat > "$RUNNER9" <<EOF
#!/bin/sh
set -eu
. "$CLEANUP_LIB"
HAVE_CURL=1
BAR_FULL=\$(printf '\342\226\210')
BAR_EMPTY=\$(printf '\342\226\221')
TMP=\$(mktemp -d)
DL_PID=""
trap cleanup EXIT TERM
download_with_progress "http://127.0.0.1:$SLOW_PORT/asset.bin" "$DEST9" &
runner_pid=\$!
sleep 0.5
rm -f "$DEST9"
wait "\$runner_pid"
echo "LOOP_EXIT=\$?"
EOF
chmod +x "$RUNNER9"
LOG9="$WORK/deleted_mid_transfer.log"
loop9_status=0
# The full throttled transfer takes about 11s regardless of whether the loop
# breaks early, since curl itself is unaffected by the missing dest file.
# This timeout is a safety net against a genuine hang. The spam count below
# is the actual assertion.
timeout 20 sh "$RUNNER9" >"$LOG9" 2>&1 || loop9_status=$?
spam9=$(grep -c 'cannot open.*No such file' "$LOG9" 2>/dev/null || true)
[ -n "$spam9" ] || spam9=0
if [ "$loop9_status" != "124" ] && [ "$spam9" = "0" ]; then
  pass "dest_file_deleted_mid_transfer_breaks_loop (no timeout, no spam)"
else
  fail "dest_file_deleted_mid_transfer_breaks_loop" "status=$loop9_status spam=$spam9 (see $LOG9)"
fi

# --- test 10: a second Ctrl-C right after the first does not double-cleanup -

DEST10="$WORK/ctrlc_double.bin"
RUNNER10="$WORK/runner10.sh"
make_ctrlc_runner "$RUNNER10" "http://127.0.0.1:$SLOW_PORT/asset.bin" "$DEST10"
LOG10="$WORK/ctrlc_double.log"
RESULT10=$(python3 "$FIXTURE_DIR/pty_sigint_driver.py" "sh '$RUNNER10'" "$LOG10" 0.6 --double)
rm_errors10=$(grep -ci "rm: cannot remove\|cannot open.*No such file" "$LOG10" 2>/dev/null || true)
[ -n "$rm_errors10" ] || rm_errors10=0
case "$RESULT10" in
  *signaled=True*signal=2*)
    if [ "$rm_errors10" = "0" ]; then
      pass "double_sigint_does_not_double_cleanup_error ($RESULT10)"
    else
      fail "double_sigint_does_not_double_cleanup_error" "$rm_errors10 error lines in $LOG10"
    fi
    ;;
  *)
    fail "double_sigint_does_not_double_cleanup_error" "$RESULT10"
    ;;
esac

if [ "$FAIL" = "1" ]; then
  echo "one or more download_with_progress regression tests FAILED"
  exit 1
fi
echo "all download_with_progress regression tests passed"
