#!/bin/sh
# Run the real-Claude regression suite in a reproducible Bun/Python container.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CONTENT_ROOT=${AIFIRST_CONTENT_REPO:-$ROOT/../aifirstcontent}
IMAGE=${AIFIRST_LIVE_TEST_IMAGE:-aifirst:live-test}
CLAUDE_BIN=${AIFIRST_DOCKER_CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}

if [ -z "$CLAUDE_BIN" ]; then
  echo "Claude Code is not installed or not on PATH." >&2
  exit 1
fi
CLAUDE_BIN=$(readlink -f "$CLAUDE_BIN")
if [ ! -x "$CLAUDE_BIN" ]; then
  echo "Claude executable is not executable: $CLAUDE_BIN" >&2
  exit 1
fi
if [ ! -f "$CONTENT_ROOT/package.json" ]; then
  echo "aifirstcontent checkout not found: $CONTENT_ROOT" >&2
  echo "Set AIFIRST_CONTENT_REPO to run the rocket Showtail integration test." >&2
  exit 1
fi

docker build --target test --tag "$IMAGE" "$ROOT"
docker run --rm \
  --env AIFIRST_CONTENT_REPO=/aifirstcontent \
  --env AIFIRST_ROCKET_E2E=1 \
  --volume "$CLAUDE_BIN:/usr/local/bin/claude:ro" \
  --volume "$CONTENT_ROOT:/aifirstcontent:ro" \
  --volume "$ROOT/test:/src/test:ro" \
  --entrypoint bun \
  "$IMAGE" test \
  ./test/responder.test.ts \
  ./test/learn-session.test.ts \
  ./test/learn-confirmation-live.test.ts \
  ./test/duckling-learn-live.test.ts \
  ./test/chapter10-learn-live.test.ts \
  ./test/rocket-showtail-e2e.test.ts
