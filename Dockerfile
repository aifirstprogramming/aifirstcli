# Build the current checkout into the same standalone Linux binary shipped to users.
FROM oven/bun:1 AS build

ARG BUN_TARGET=bun-linux-x64
ARG BINARY=aifirst-linux-x64

WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun scripts/build.ts --target "$BUN_TARGET"

# Test target keeps Bun and adds the book runtimes needed by live Claude tests.
FROM build AS test
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 python3-pil python3-pygame \
    && rm -rf /var/lib/apt/lists/*

# Keep the manual-test image independent of Bun and the source checkout at runtime.
FROM debian:bookworm-slim

ARG BINARY=aifirst-linux-x64

RUN apt-get update \
    && apt-get install --no-install-recommends -y bash ca-certificates curl default-jre-headless python3 python3-pil python3-pygame ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash aifirst \
    && mkdir -p /opt/claude /workspace \
    && chown aifirst:aifirst /workspace

# Claude's native installer keeps its runtime outside the mounted learner home.
RUN HOME=/opt/claude bash -c 'curl -fsSL https://claude.ai/install.sh | bash' \
    && test -x /opt/claude/.local/bin/claude

COPY --from=build /src/bin/${BINARY} /usr/local/bin/aifirst
RUN chmod 0755 /usr/local/bin/aifirst

USER aifirst
ENV HOME=/home/aifirst \
    PATH=/opt/claude/.local/bin:/usr/local/bin:/usr/bin:/bin \
    XDG_STATE_HOME=/home/aifirst/.local/state
WORKDIR /workspace

ENTRYPOINT ["aifirst"]
CMD ["help"]
