#!/bin/sh
# macOS regression test for a piped installer followed by direct interactive setup.

set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "test-macos-installer-tty.sh only runs on macOS" >&2
  exit 2
fi
if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  echo "usage: sh install/test-macos-installer-tty.sh <darwin-binary>" >&2
  exit 2
fi

# shellcheck disable=SC1007
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
INSTALL_SH="$SCRIPT_DIR/install.sh"
# shellcheck disable=SC1007
BINARY=$(CDPATH= cd -- "$(dirname "$1")" && pwd)/$(basename "$1")
PYTHON=$(command -v python3)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

FAKE_BIN="$WORK/bin"
TEST_HOME="$WORK/home"
INSTALL_DIR="$WORK/install"
mkdir -p "$FAKE_BIN" "$TEST_HOME/.claude" "$INSTALL_DIR"

ASSET_NAME=$(basename "$BINARY")
ASSET_HASH=$(shasum -a 256 "$BINARY" | awk '{print $1}')
export AIFIRST_TEST_BINARY="$BINARY"
export AIFIRST_TEST_ASSET_NAME="$ASSET_NAME"
export AIFIRST_TEST_ASSET_HASH="$ASSET_HASH"

# The installer still performs its real download and checksum flow; this curl
# replacement serves the just-built binary without depending on a published tag.
cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/sh
set -eu

head_only=0
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -I) head_only=1 ;;
    -o)
      shift
      output=$1
      ;;
    http://*|https://*) url=$1 ;;
  esac
  shift
done

name=$(basename "$url")
if [ "$name" = "SHA256SUMS" ]; then
  size=$(printf '%s  %s\n' "$AIFIRST_TEST_ASSET_HASH" "$AIFIRST_TEST_ASSET_NAME" | wc -c | tr -d ' ')
else
  size=$(wc -c < "$AIFIRST_TEST_BINARY" | tr -d ' ')
fi

if [ "$head_only" = "1" ]; then
  printf 'HTTP/1.1 200 OK\nContent-Length: %s\n\n' "$size"
elif [ -n "$output" ]; then
  if [ "$name" = "SHA256SUMS" ]; then
    printf '%s  %s\n' "$AIFIRST_TEST_ASSET_HASH" "$AIFIRST_TEST_ASSET_NAME" > "$output"
  else
    cp "$AIFIRST_TEST_BINARY" "$output"
  fi
else
  printf '{"tag_name":"v0.0.0-test"}\n'
fi
EOF
chmod +x "$FAKE_BIN/curl"

RUNNER="$WORK/runner.sh"
cat > "$RUNNER" <<'EOF'
#!/bin/sh
set -eu

# The inner shell has piped stdin exactly like `curl ... | bash`, while this
# outer runner retains the PTY for the follow-up direct invocation.
cat "$AIFIRST_TEST_INSTALL_SH" | /bin/sh
printf 'INSTALLER_FINISHED\n'
"$AIFIRST_INSTALL_DIR/aifirst" init
printf 'DIRECT_INIT_FINISHED\n'
EOF
chmod +x "$RUNNER"

export AIFIRST_TEST_INSTALL_SH="$INSTALL_SH"
export AIFIRST_INSTALL_DIR="$INSTALL_DIR"
export AIFIRST_VERSION="0.0.0-test"
export HOME="$TEST_HOME"
export NO_COLOR=1
export PATH="$FAKE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"

LOG="$WORK/session.log"
"$PYTHON" "$SCRIPT_DIR/fixtures/macos_installer_tty_driver.py" "$RUNNER" "$LOG"

grep -q 'On macOS, finish setup in a new terminal:' "$LOG"
grep -q 'INSTALLER_FINISHED' "$LOG"
grep -q 'Set up 1 tool? \[Y/n\]' "$LOG"
grep -q 'Nothing installed.' "$LOG"
grep -q 'DIRECT_INIT_FINISHED' "$LOG"

installer_line=$(grep -n 'INSTALLER_FINISHED' "$LOG" | head -n1 | cut -d: -f1)
prompt_line=$(grep -n 'Set up 1 tool? \[Y/n\]' "$LOG" | head -n1 | cut -d: -f1)
if [ "$prompt_line" -le "$installer_line" ]; then
  echo "interactive prompt appeared inside the piped installer" >&2
  exit 1
fi

echo "  ok   piped macOS installer defers setup; direct init accepts input"
