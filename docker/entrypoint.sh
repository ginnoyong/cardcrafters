#!/bin/sh
set -e

echo "[entrypoint] applying Prisma migrations..."
npx prisma migrate deploy
echo "[entrypoint] migrations applied — starting: $*"
exec "$@"
