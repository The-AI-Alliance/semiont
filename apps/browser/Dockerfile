# Stage 1: install (npm runs here, then is discarded).
FROM node:26-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_BROWSER_VERSION=latest
WORKDIR /app
# Cache mount, same shape and rationale as apps/gateway/Dockerfile: persists
# across --no-cache builds, never enters the image, republished @semiont/*
# still fetch fresh. No `npm cache clean` — the cache never reaches a layer.
RUN --mount=type=cache,target=/root/.npm \
    npm config set registry $NPM_REGISTRY && \
    npm init -y && \
    npm install @semiont/browser@${SEMIONT_BROWSER_VERSION}

# Stage 2: minimal runtime — node only, no npm. The runtime entrypoint is
# `node server.js`, so npm is build-only baggage. Removing it also drops
# the picomatch / glob / etc. CVE surface that ships inside npm's bundled
# node_modules.
FROM node:26-alpine
# Patch base-image OS packages so alpine security fixes (e.g. the openssl
# libcrypto3/libssl3 HIGH CVE flagged by the Trivy gate) apply even when the
# node:26-alpine snapshot hasn't been rebuilt against them yet.
RUN apk upgrade --no-cache
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

WORKDIR /app
RUN chown semiont:nodejs /app
USER semiont

COPY --from=installer --chown=semiont:nodejs /app /app
COPY LICENSE apps/browser/NOTICE /app/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"

# tini is PID 1; boot.sh runs the CMD directly unless the run sets
# SEMIONT_SUPERVISE (the launcher does, for local placement — the one runtime
# with no restart policy of its own: the HEALTHCHECK above states a contract
# neither Apple container nor docker can act on there). A dead browser is the
# stack's most user-visible failure: every user gets a blank page, where a
# dead sidecar only degrades a feature. Unsupervised, the image is a
# conventional one-process container — it exits on child death, and the
# platform's own restart policy is the only one in play.
#
# Deliberately the cheap half of supervision. The browser mounts no writable
# /semiont-state (only /discovery, read-only), so supervise.sh falls back to
# /tmp and the death record does NOT survive teardown. That is accepted, not
# overlooked: mounting per-root state into a machine-level service to hold a
# record would be a worse coupling than the gap it closes, and a supervised
# container no longer exits on child death, so `container logs` keeps the
# crash history for as long as it matters.
RUN apk add --no-cache tini
COPY scripts/container/supervise.sh /usr/local/bin/supervise.sh
COPY scripts/container/boot.sh /usr/local/bin/boot.sh
ENV SUPERVISE_NAME=browser \
    SUPERVISE_PROBE=http://localhost:3000/
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/boot.sh"]
CMD ["node", "/app/node_modules/@semiont/browser/server.js"]
