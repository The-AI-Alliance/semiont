# Stage 1: install (npm runs here, then is discarded).
FROM node:26-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_VERSION=latest
RUN npm config set registry $NPM_REGISTRY && \
    npm install -g @semiont/jobs@${SEMIONT_VERSION} && \
    npm cache clean --force

# Stage 2: minimal runtime — node only, no npm. The runtime entrypoint is
# `node worker-main.js`, so npm is build-only baggage. Removing it also drops
# the picomatch / glob / etc. CVE surface that ships inside npm's bundled
# node_modules.
FROM node:26-alpine
# Patch base-image OS packages so alpine security fixes apply even when the
# node:26-alpine snapshot hasn't been rebuilt against them yet.
RUN apk upgrade --no-cache

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

# The global @semiont/jobs (with its hoisted deps) and its bin symlinks.
COPY --from=installer /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=installer /usr/local/bin /usr/local/bin

# Strip npm/npx after the COPY above re-introduces them from the installer tree.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

COPY LICENSE packages/jobs/NOTICE /home/semiont/

WORKDIR /kb
RUN chown semiont:nodejs /kb
USER semiont

ENV NODE_ENV=production
EXPOSE 9090

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9090/health', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "/usr/local/lib/node_modules/@semiont/jobs/dist/worker-main.js"]
