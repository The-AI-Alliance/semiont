# Stage 1: install (npm runs here, then is discarded).
FROM node:22-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_FRONTEND_VERSION=latest
WORKDIR /app
RUN npm config set registry $NPM_REGISTRY && \
    npm init -y && \
    npm install @semiont/frontend@${SEMIONT_FRONTEND_VERSION} && \
    npm cache clean --force

# Stage 2: minimal runtime — node only, no npm. The runtime entrypoint is
# `node server.js`, so npm is build-only baggage. Removing it also drops
# the picomatch / glob / etc. CVE surface that ships inside npm's bundled
# node_modules.
FROM node:22-alpine
RUN apk add --no-cache curl && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

WORKDIR /app
RUN chown semiont:nodejs /app
USER semiont

COPY --from=installer --chown=semiont:nodejs /app /app
COPY LICENSE apps/frontend/NOTICE /app/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

CMD ["node", "node_modules/@semiont/frontend/server.js"]
