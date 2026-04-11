FROM node:22-alpine

RUN apk add --no-cache curl

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

WORKDIR /app
RUN chown semiont:nodejs /app

USER semiont

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_FRONTEND_VERSION=latest
RUN npm config set registry $NPM_REGISTRY && \
    npm init -y && \
    npm install @semiont/frontend@${SEMIONT_FRONTEND_VERSION} && \
    npm cache clean --force

COPY LICENSE apps/frontend/NOTICE /app/
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

CMD ["node", "node_modules/@semiont/frontend/standalone/apps/frontend/server.js"]
