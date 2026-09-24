# node:24, not 26: node 26's built-in undici breaks the qdrant client at connect.
FROM node:24-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_VERSION=latest
RUN --mount=type=cache,target=/root/.npm \
    npm config set registry $NPM_REGISTRY && \
    npm install -g npm@12.0.1 && \
    npm install @semiont/gateway@${SEMIONT_VERSION} neo4j-driver @qdrant/js-client-rest \
      --prefix /home/semiont/.local/share/semiont

FROM node:24-alpine
ARG SEMIONT_VERSION=latest
RUN apk upgrade --no-cache

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

COPY --from=installer /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=installer /usr/local/bin /usr/local/bin
COPY --from=installer --chown=semiont:nodejs /home/semiont/.local/share/semiont /home/semiont/.local/share/semiont

# Strip npm/npx (re-introduced by the COPY above). Nothing at runtime runs them:
# the CMD is `node` on the built server.
#
# DO NOT delete a prune here because the package is absent from the monorepo
# lockfile. This image does not build from the monorepo -- the installer stage
# runs `npm install @semiont/gateway@$SEMIONT_VERSION` against npm, so its tree
# is whatever the PUBLISHED gateway depends on, which lags main by a release.
# Doing exactly that once failed the Trivy gate with two HIGH CVEs. Verify with
# `npm view @semiont/gateway dependencies`, not with the lockfile.
#
# Absence from a published image's SBOM is NOT evidence a prune is dead: a prune
# removes, so absence is what a working prune looks like. (A patch that replaces
# a version in place is different -- there, absence does mean nothing pulls it.)
#
# mysql2 by -path, not -name: -name would also delete studio-core's data/mysql2 shim.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx && \
    find /usr/local/lib/node_modules /home/semiont/.local/share/semiont \
      -type d \( -name typescript -o -name '@typescript' -o -name elkjs \
                 -o -path '*/node_modules/mysql2' \) \
      -prune -exec rm -rf {} +

COPY LICENSE apps/gateway/NOTICE /home/semiont/

WORKDIR /kb
RUN chown semiont:nodejs /kb
# Supervision runtime — ROOT-TIME on purpose: apk refuses to run and
# /usr/local/bin refuses writes once USER drops privileges below.
RUN apk add --no-cache tini
COPY scripts/container/supervise.sh /usr/local/bin/supervise.sh
COPY scripts/container/boot.sh /usr/local/bin/boot.sh

USER semiont

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/api/health', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"

ENV SEMIONT_ENV=local
ENV GATEWAY_DIR=/home/semiont/.local/share/semiont/node_modules/@semiont/gateway

# The image publishes ONE binary and nothing execs it by name: CMD is `node` on
# an absolute path. No `.bin` on PATH, and nothing to assert but the file CMD
# runs.
RUN test -f "$GATEWAY_DIR/dist/index.js" \
      || { echo "GATEWAY_DIR does not contain dist/index.js: $GATEWAY_DIR"; exit 1; }

ENV SUPERVISE_NAME=gateway \
    SUPERVISE_PROBE=http://localhost:4000/api/health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/boot.sh"]
CMD ["node", "/home/semiont/.local/share/semiont/node_modules/@semiont/gateway/dist/index.js"]
