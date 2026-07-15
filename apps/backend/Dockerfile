# Stage 1: install (npm runs here, then is discarded).
#
# The backend image drives the role through the `@semiont/cli` global bin
# (`semiont provision/start/useradd`), which loads the service package from the
# semiont data dir. So we install two trees: the CLI globally, and the backend
# package plus its lazy peers into the prefix the CLI reads services from.
# neo4j-driver and @qdrant/js-client-rest are lazy peers of @semiont/graph and
# @semiont/vector (loaded at connect time) — the backend dials both, so they are
# bundled here explicitly rather than installed at startup.
FROM node:26-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_VERSION=latest
RUN npm config set registry $NPM_REGISTRY && \
    npm install -g @semiont/cli@${SEMIONT_VERSION} && \
    npm install @semiont/backend@${SEMIONT_VERSION} neo4j-driver @qdrant/js-client-rest \
      --prefix /home/semiont/.local/share/semiont && \
    npm cache clean --force

# Stage 2: minimal runtime — node + git, no npm. The runtime entrypoint is the
# `semiont` CLI; npm is build-only baggage. Removing it also drops the
# picomatch / glob / etc. CVE surface that ships inside npm's bundled
# node_modules.
FROM node:26-alpine
# Patch base-image OS packages so alpine security fixes apply even when the
# node:26-alpine snapshot hasn't been rebuilt against them yet.
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

# Strip npm/npx (re-introduced by the COPY above) plus the TypeScript compiler.
# `typescript` + its native `@typescript/*` Go binaries are pulled transitively
# via the qdrant client's dep chain but never loaded at runtime — build-only
# baggage, and the native `tsc` carries a Go-stdlib CVE (CVE-2026-39822).
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx && \
    find /usr/local/lib/node_modules /home/semiont/.local/share/semiont \
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
