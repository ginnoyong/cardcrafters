# syntax=docker/dockerfile:1
# Multi-stage build on Debian (node:22-slim) — sharp/@napi-rs/canvas prebuilt
# binaries are most reliable on glibc/Debian, not musl/Alpine.

FROM node:22-slim AS builder
WORKDIR /app

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

COPY --from=builder /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/apps/web ./apps/web

EXPOSE 3000
# Minimal scaffold bootstrap: health endpoint only.
# TODO(Step 3): full custom server wiring Next + Socket.IO.
CMD ["node_modules/.bin/tsx", "apps/web/server.ts"]