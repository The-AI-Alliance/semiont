# Single-stage: install pre-built @semiont/frontend from npm
FROM node:22-alpine

ARG SEMIONT_VERSION=latest
ARG BUILD_VERSION
ARG BUILD_SHA

# Build-time environment variables embedded in the Next.js bundle
ARG NEXT_PUBLIC_SITE_NAME=Semiont
ARG NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS=example.com

WORKDIR /app

# Install the pre-built frontend package from npm
RUN npm init -y && \
    npm install @semiont/frontend@${SEMIONT_VERSION}

# Install runtime dependencies
RUN apk add --no-cache openssl curl

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Set ownership
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Run the standalone server from the installed package
# Next.js standalone output preserves monorepo directory structure
CMD ["node", "node_modules/@semiont/frontend/standalone/apps/frontend/server.js"]
