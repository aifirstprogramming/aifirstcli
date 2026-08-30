#!/bin/sh
# Build and run the current checkout in an isolated manual-test container.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
IMAGE=${AIFIRST_DOCKER_IMAGE:-aifirst:dev}
VOLUME=${AIFIRST_DOCKER_VOLUME:-aifirst-cli-test-home}
CLAUDE_BIN=${AIFIRST_DOCKER_CLAUDE_BIN:-}
HOST_HOME=${HOME:-}
X11_AUTHORITY=''

usage() {
  cat <<EOF
Usage:
  ./scripts/docker-test.sh [aifirst arguments...]
  ./scripts/docker-test.sh shell
  ./scripts/docker-test.sh clean

Examples:
  ./scripts/docker-test.sh show py-1-01
  ./scripts/docker-test.sh run py-1-01
  ./scripts/docker-test.sh shell

The image is rebuilt from the current checkout by default. Learner state is
kept in the named Docker volume "$VOLUME" so repeated commands share progress.
When DISPLAY is set, the container automatically receives the host X11 display
and authentication cookie. SDL's cross-container MIT-SHM probe is disabled so
pygame falls back to ordinary X11 image transfers.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  clean)
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    echo "Removed Docker volume: $VOLUME"
    exit 0
    ;;
esac

if [ -n "${DISPLAY:-}" ]; then
  X11_AUTHORITY=${XAUTHORITY:-}
  if [ -z "$X11_AUTHORITY" ] && [ -n "$HOST_HOME" ]; then
    X11_AUTHORITY=$HOST_HOME/.Xauthority
  fi
  if [ -z "$X11_AUTHORITY" ] || [ ! -r "$X11_AUTHORITY" ]; then
    echo "DISPLAY is set, but no readable Xauthority file was found." >&2
    echo "Set XAUTHORITY to the cookie file for $DISPLAY." >&2
    exit 1
  fi
fi

machine=$(uname -m)
case "$machine" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Unsupported host architecture: $machine" >&2; exit 1 ;;
esac

docker build \
  --build-arg "BUN_TARGET=bun-linux-$arch" \
  --build-arg "BINARY=aifirst-linux-$arch" \
  --tag "$IMAGE" \
  "$ROOT"

tty=''
[ -t 0 ] && tty='-t'

run_container() {
  if [ -z "$X11_AUTHORITY" ]; then
    exec docker run "$@"
  fi

  if [ -d /tmp/.X11-unix ]; then
    exec docker run \
      --network host \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --security-opt "seccomp=$ROOT/scripts/docker-no-xshm.json" \
      --env "DISPLAY=$DISPLAY" \
      --env XAUTHORITY=/tmp/.docker-xauthority \
      --env SDL_VIDEODRIVER=x11 \
      --volume "$X11_AUTHORITY:/tmp/.docker-xauthority:ro" \
      --volume /tmp/.X11-unix:/tmp/.X11-unix:ro \
      "$@"
  fi

  exec docker run \
    --network host \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --security-opt "seccomp=$ROOT/scripts/docker-no-xshm.json" \
    --env "DISPLAY=$DISPLAY" \
    --env XAUTHORITY=/tmp/.docker-xauthority \
    --env SDL_VIDEODRIVER=x11 \
    --volume "$X11_AUTHORITY:/tmp/.docker-xauthority:ro" \
    "$@"
}

# Keep Claude's color and terminal feature detection consistent with the host.
terminal_env=''
[ -n "${TERM:-}" ] && terminal_env="$terminal_env --env TERM=$TERM"
[ -n "${COLORTERM:-}" ] && terminal_env="$terminal_env --env COLORTERM=$COLORTERM"
[ -n "${TERM_PROGRAM:-}" ] && terminal_env="$terminal_env --env TERM_PROGRAM=$TERM_PROGRAM"
[ -n "${TERM_PROGRAM_VERSION:-}" ] && terminal_env="$terminal_env --env TERM_PROGRAM_VERSION=$TERM_PROGRAM_VERSION"

claude_mount=''
if [ -n "$CLAUDE_BIN" ]; then
  if [ ! -x "$CLAUDE_BIN" ]; then
    echo "Claude executable is not executable: $CLAUDE_BIN" >&2
    exit 1
  fi
  claude_mount="--volume $CLAUDE_BIN:/usr/local/bin/claude:ro"
fi

# Reuse Claude Code login state without exposing the rest of the host profile.
# Copy credentials into the named home volume: binding a nested credential file
# makes Docker create ~/.claude as root, which blocks skills and transcripts.
claude_auth_source_mount=''
if [ -n "$HOST_HOME" ]; then
  if [ -f "$HOST_HOME/.claude.json" ]; then
    claude_auth_source_mount="$claude_auth_source_mount --volume $HOST_HOME/.claude.json:/tmp/host-claude.json:ro"
  fi
  if [ -f "$HOST_HOME/.claude/.credentials.json" ]; then
    claude_auth_source_mount="$claude_auth_source_mount --volume $HOST_HOME/.claude/.credentials.json:/tmp/host-claude-credentials.json:ro"
  fi
fi

docker run --rm --user root \
  $claude_auth_source_mount \
  --volume "$VOLUME:/home/aifirst" \
  --entrypoint /bin/sh \
  "$IMAGE" -c '
    mkdir -p /home/aifirst/.claude
    chown 1000:1000 /home/aifirst /home/aifirst/.claude
    if [ -f /tmp/host-claude.json ]; then
      install -m 600 -o 1000 -g 1000 /tmp/host-claude.json /home/aifirst/.claude.json
    fi
    if [ -f /tmp/host-claude-credentials.json ]; then
      install -m 600 -o 1000 -g 1000 /tmp/host-claude-credentials.json /home/aifirst/.claude/.credentials.json
    fi
  '

if [ "${1:-}" = "shell" ]; then
  shift
  set --
  run_container --rm -i $tty --init \
    $claude_mount \
    $terminal_env \
    --volume "$VOLUME:/home/aifirst" \
    --volume "$ROOT:/checkout:ro" \
    --workdir /workspace \
    --entrypoint /bin/bash \
    "$IMAGE" "$@"
fi

run_container --rm -i $tty --init \
  $claude_mount \
  $terminal_env \
  --volume "$VOLUME:/home/aifirst" \
  --workdir /workspace \
  "$IMAGE" "$@"
