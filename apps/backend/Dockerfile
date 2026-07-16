# Stage 1: install (npm runs here, then is discarded).
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
# method" on connect), and node 26's newer npm (11.16.0) bundles a vulnerable
# undici. node 24 avoids both; the qdrant client has no newer release that fixes
# the node-26 incompatibility.
FROM node:24-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_VERSION=latest
RUN npm config set registry $NPM_REGISTRY && \
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
# (spawnSync npx ENOENT). node:24-alpine's npm (11.11.0) bundles no undici, so
# keeping npm is clean for the Trivy gate.
#
# We still drop the TypeScript compiler: `typescript` + its native `@typescript/*`
# Go binaries are pulled transitively (via the qdrant client's dep chain) but
# never loaded at runtime, and the native `tsc` carries a Go-stdlib CVE
# (CVE-2026-39822).
RUN find /usr/local/lib/node_modules /home/semiont/.local/share/semiont \
      -type d \( -name typescript -o -name '@typescript' \) -prune -exec rm -rf {} +

COPY LICENSE apps/backend/NOTICE /home/semiont/

WORKDIR /kb
RUN chown semiont:nodejs /kb
USER semiont

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=6144
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
