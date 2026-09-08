#!/bin/sh
# gateway-boot.sh — the gateway's boot steps, ahead of the shared entrypoint
# (ORCHESTRATOR-NATIVE-IMAGES D5). These run ONCE PER CONTAINER, never per
# restart: re-deriving DATABASE_URL and re-running migrations on every
# restart would add latency to exactly the path that needs to be fast, and
# `migrate deploy` is the container's job, not the supervisor's.
#
# DATABASE_URL: set it to override the config-derived value (an external or
# TLS-requiring database); when set, the derivation is skipped.
set -e
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="$(node "$GATEWAY_DIR/dist/cli/db-url.js")"
  export DATABASE_URL
fi
(cd "$GATEWAY_DIR" && npx prisma migrate deploy --schema=prisma/schema.prisma)
exec /usr/local/bin/boot.sh "$@"
