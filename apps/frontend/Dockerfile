# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/api-client/package.json ./packages/api-client/

# Install all dependencies
RUN npm ci

# Copy source files
COPY apps/frontend ./apps/frontend
COPY packages/api-client ./packages/api-client
COPY specs ./specs
COPY tsconfig.json ./

# Build api-client first (frontend depends on it)
RUN npm run build -w packages/api-client

# Build frontend (this creates the .next directory with standalone output)
WORKDIR /app/apps/frontend
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install runtime dependencies
RUN apk add --no-cache openssl curl

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output from builder
# Next.js standalone output includes everything needed to run the app
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/public ./apps/frontend/public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Health check - check root path to match ALB configuration
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Run the standalone server
CMD ["node", "apps/frontend/server.js"]