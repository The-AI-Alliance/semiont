# Stage 1: install. Unlike the other service images, the backend does NOT discard
# npm afterward — the runtime stage copies it over for `npx prisma` (see below).
#
# The backend image drives the role through the `@semiont/cli` global bin
# (`semiont provision/start/useradd`), which loads the service package from the
# semiont data dir. So we install two trees: the CLI globally, and the backend
# package plus its lazy peers into the prefix the CLI reads services from.
# neo4j-driver and @qdrant/js-client-rest are lazy peers of @semiont/graph and
# @semiont/vector (loaded at connect time) — the backend dials both, so they are
# bundled here explicitly rather than installed at startup.
#
# Base is node:24-alpine, NOT node:26 like the frontend: node 26's built-in undici
# is incompatible with the qdrant client's undici@6 (throws "invalid onError
# method" on connect), and the qdrant client has no newer release that fixes it.
FROM node:24-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_VERSION=latest
# The backend KEEPS npm at runtime (for `npx prisma`), so npm's own bundled deps
# ship in the image and face the Trivy gate. node:24-alpine's npm (11.16.0) bundles
# tar 7.5.15 (CVE-2026-59873 CRITICAL, CVE-2026-59874 HIGH), brace-expansion 5.0.6
# (CVE-2026-13149 HIGH), and undici 6.26.0 (CVE-2026-12151 HIGH). Pin npm to 12.0.1,
# which bundles tar 7.5.19, brace-expansion 5.0.7, and undici 6.27.0 — all fixed.
RUN npm config set registry $NPM_REGISTRY && \
    npm install -g npm@12.0.1 && \
    npm install -g @semiont/cli@${SEMIONT_VERSION} && \
    npm install @semiont/backend@${SEMIONT_VERSION} neo4j-driver @qdrant/js-client-rest \
      --prefix /home/semiont/.local/share/semiont && \
    npm cache clean --force

# Stage 2: runtime — node + git + npm. Unlike the other service images, the
# backend KEEPS npm because it shells out to `npx prisma` at provision/start time.
FROM node:24-alpine
# Patch base-image OS packages so alpine security fixes apply even when the
# node:24-alpine snapshot hasn't been rebuilt against them yet.
RUN apk upgrade --no-cache && \
    apk add --no-cache git && \
    # /kb is bind-mounted from the host. When the host UID doesn't match the
    # in-container semiont user (UID 1001), git's CVE-2022-24765 dubious-ownership
    # check refuses to operate. --system writes /etc/gitconfig, applied to all
    # users in the image.
    git config --system --add safe.directory /kb

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

# The global @semiont/cli (with its hoisted deps) and the `semiont` bin symlink,
# plus the backend package + lazy peers the CLI loads services from.
COPY --from=installer /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=installer /usr/local/bin /usr/local/bin
COPY --from=installer --chown=semiont:nodejs /home/semiont/.local/share/semiont /home/semiont/.local/share/semiont

# The backend KEEPS npm/npx (see the base-image note above): at runtime
# `semiont provision` runs `npx prisma generate` and `semiont start` runs
# `npx prisma migrate`, so removing npx makes the backend fail to start
# (spawnSync npx ENOENT). npm is pinned to 12.0.1 in the installer stage above,
# whose bundled tar/brace-expansion/undici are all CVE-free, so keeping npm is
# clean for the Trivy gate.
#
# We still drop two things pulled transitively but never loaded at runtime:
#   - the TypeScript compiler: `typescript` + its native `@typescript/*` Go
#     binaries (via the qdrant client's dep chain); the native `tsc` carries a
#     Go-stdlib CVE (CVE-2026-39822).
#   - `elkjs`: pulled by @prisma/studio-core (via prisma@7.9.0) for Prisma
#     Studio's graph layout. It is EPL-2.0 — not on the license allowlist — and
#     is lazy-loaded only by the Studio GUI, which the backend never runs (it
#     shells out to `npx prisma generate`/`migrate`). studio-core itself stays:
#     it is Apache-2.0 and prisma's CLI top-level-requires it (removing it breaks
#     `prisma generate`), while removing only elkjs leaves the CLI working.
RUN find /usr/local/lib/node_modules /home/semiont/.local/share/semiont \
      -type d \( -name typescript -o -name '@typescript' -o -name elkjs \) \
      -prune -exec rm -rf {} +

COPY LICENSE apps/backend/NOTICE /home/semiont/

WORKDIR /kb
RUN chown semiont:nodejs /kb
USER semiont

ENV NODE_ENV=production
# Deliberately NO explicit --max-old-space-size: node:24 is cgroup-aware and
# sizes the heap to ~half the container memory limit, making --memory /
# mem_limit the single memory knob. A baked heap override defeats that — it
# licensed the heap past small container limits (OOM-kill instead of GC
# pressure) and was an unmeasured 2026-04 artifact, not a profiled need.
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/api/health', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"

CMD semiont provision --service backend --verbose && \
    semiont provision --service embedding --verbose && \
    semiont start --service backend --verbose && \
    if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then \
      semiont useradd --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" --admin --upsert; \
    fi && \
    semiont useradd --email worker@semiont.local --generate-password --upsert && \
    tail -f /home/semiont/.local/state/semiont/*/backend/app.log
