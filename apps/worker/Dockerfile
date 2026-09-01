# worker image.
#
# THE ENTRYPOINT SOURCE IS NOT IN THIS DIRECTORY. This image installs the
# published @semiont/jobs and runs `dist/worker-main.js` out of it; the
# source is packages/jobs/src/worker-main.ts. Only the image
# recipe lives here — the entrypoint stayed in its package deliberately, so
# that moving it out would not have to promote ~18 of that package's
# internals to public API just to satisfy a directory layout. If you change
# the CMD, change it against that file.
#
# Stage 1: install (npm runs here, then is discarded).
#
# Base is node:24-alpine (not node:26): node 26's built-in undici breaks the
# qdrant client's undici@6, which @semiont/* can load transitively at connect
# time. Keep in sync with the gateway image.
FROM node:24-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_VERSION=latest
RUN npm config set registry $NPM_REGISTRY && \
    npm install -g @semiont/jobs@${SEMIONT_VERSION} && \
    npm cache clean --force

# Stage 2: minimal runtime — node only, no npm. The runtime entrypoint is
# `node worker-main.js`, so npm is build-only baggage. Removing it also drops
# the picomatch / glob / etc. CVE surface that ships inside npm's bundled
# node_modules.
FROM node:24-alpine
# Patch base-image OS packages so alpine security fixes apply even when the
# node:24-alpine snapshot hasn't been rebuilt against them yet.
RUN apk upgrade --no-cache

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

# The global @semiont/jobs (with its hoisted deps) and its bin symlinks.
COPY --from=installer /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=installer /usr/local/bin /usr/local/bin

# Typst renderer for PDF generation (PDF-GENERATION P2, approved 2026-08-04).
# Pinned to the version the P0 spike measured — the recorded citation geometry
# is a property of this version's layout. Alpine/musl build, same libc as this
# base. The binary embeds its default Latin fonts (Libertinus, SIL OFL), which
# covers the day-one locales (en/es/de/fr) with no separate font files; the
# non-Latin tiers are a deliberate later pass. Every invocation must pin
# --creation-timestamp — unpinned compiles change bytes on identical input,
# which churns content checksums and re-embeds forever (S11/S12).
# Attribution lives in NOTICE (Apache-2.0 + the embedded font licenses, which
# no scanner can see inside a bare binary) — bump the version there in the
# same diff as this tag.
COPY --from=ghcr.io/typst/typst:0.15.1 /bin/typst /usr/local/bin/typst

# Strip npm/npx after the COPY above re-introduces them from the installer tree.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

COPY LICENSE apps/worker/NOTICE /home/semiont/

WORKDIR /kb
RUN chown semiont:nodejs /kb
USER semiont

ENV NODE_ENV=production
EXPOSE 9090

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9090/health', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "/usr/local/lib/node_modules/@semiont/jobs/dist/worker-main.js"]
