# syntax=docker/dockerfile:1
# Multi-stage build on Debian (node:22-slim) — sharp/@napi-rs/canvas prebuilt
# binaries are most reliable on glibc/Debian, not musl/Alpine.

FROM node:22-slim AS builder
WORKDIR /app

# Prisma needs the openssl binary to pick the correct query engine for Debian.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Copy manifests first for layer caching, then install all workspace deps.
COPY package.json package-lock.json tsconfig.base.json ./
COPY prisma ./prisma
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci

# Copy sources, generate the Prisma client, and build the Next app.
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN npx prisma generate
RUN npm run build --workspace @cardcrafters/web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Prisma CLI (migrate deploy in the entrypoint) detects libssl via the openssl
# binary — without it the CLI falls back to the wrong engine family.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/apps/web ./apps/web
# AI task registry + prompt templates are loaded from ./config at runtime.
COPY config ./config

# Apply Prisma migrations before boot (idempotent on restarts).
COPY --chmod=755 docker/entrypoint.sh /app/docker/entrypoint.sh
ENTRYPOINT ["/app/docker/entrypoint.sh"]

EXPOSE 3000
CMD ["node_modules/.bin/tsx", "apps/web/server.ts"]