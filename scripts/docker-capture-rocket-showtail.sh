#!/bin/sh
# Regenerate the real-Claude rocket fixture in the reproducible test image.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SHOWTAIL_ROOT=${SHOWTAIL_REPO:-$(CDPATH= cd -- "$ROOT/../.." && pwd)/Showtail}
CONTENT_ROOT=${AIFIRST_CONTENT_REPO:-$ROOT/../aifirstcontent}
IMAGE=${AIFIRST_ROCKET_CAPTURE_IMAGE:-aifirst:rocket-capture}
CLAUDE_BIN=${AIFIRST_DOCKER_CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}

if [ -z "$CLAUDE_BIN" ]; then
  echo "Claude Code is not installed or not on PATH." >&2
  exit 1
fi
CLAUDE_BIN=$(readlink -f "$CLAUDE_BIN")
if [ ! -f "$SHOWTAIL_ROOT/src/cli.ts" ]; then
  echo "Showtail checkout not found: $SHOWTAIL_ROOT" >&2
  exit 1
fi
if [ ! -f "$CONTENT_ROOT/package.json" ]; then
  echo "aifirstcontent checkout not found: $CONTENT_ROOT" >&2
  exit 1
fi

docker build --target test --tag "$IMAGE" "$ROOT"

auth_mounts=""
if [ -f "$HOME/.claude.json" ]; then
  auth_mounts="$auth_mounts --volume $HOME/.claude.json:/host-auth/.claude.json:ro"
fi
if [ -f "$HOME/.claude/.credentials.json" ]; then
  auth_mounts="$auth_mounts --volume $HOME/.claude/.credentials.json:/host-auth/.claude/.credentials.json:ro"
fi

docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp/rocket-container-home \
  --env AIFIRST_CLAUDE_AUTH_HOME=/host-auth \
  --volume "$CLAUDE_BIN:/usr/local/bin/claude:ro" \
  --volume "$SHOWTAIL_ROOT:/showtail:ro" \
  --volume "$CONTENT_ROOT:/aifirstcontent" \
  $auth_mounts \
  --entrypoint bun \
  "$IMAGE" run scripts/capture-rocket-showtail.ts \
  --showtail-repo /showtail \
  --content-repo /aifirstcontent \
  --replace
