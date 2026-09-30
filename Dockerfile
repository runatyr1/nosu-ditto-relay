# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Dependencies. Isolated in its own stage so that changing source files does
# not invalidate the (slow) install layer.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS deps

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# Runtime. There is no build step: Bun runs the TypeScript sources directly,
# so the image is the dependency tree plus the sources.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=13131

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY service-config.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# Unprivileged user shipped by the base image.
RUN mkdir -p /data && chown bun:bun /data
USER bun

EXPOSE 13131

# The landing page and the WebSocket endpoint share a port, so a plain GET /
# is a sufficient liveness probe. Uses Bun rather than curl, which the slim
# base image does not ship.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD \
  bun -e 'fetch(`http://127.0.0.1:${process.env.PORT ?? 13131}/`).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

# Exec form, so Bun is PID 1 and receives SIGTERM directly — src/server.ts
# handles it and shuts the workers down cleanly.
CMD ["bun", "src/server.ts"]
