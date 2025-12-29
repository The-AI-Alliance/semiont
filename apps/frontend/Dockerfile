# Build stage
FROM node:22-alpine AS builder

# Build args to bust cache when version changes
ARG BUILD_VERSION
ARG BUILD_SHA

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

# Set build-time environment variables
# These are required for Next.js build and get baked into the bundle
# They can be overridden at runtime for NEXT_PUBLIC_* vars via window.__ENV
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_SITE_NAME=Semiont
ARG NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS=example.com
ARG NEXTAUTH_URL=http://localhost:3000
ARG NEXTAUTH_SECRET=build-time-secret-min-32-chars

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SITE_NAME=$NEXT_PUBLIC_SITE_NAME
ENV NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS=$NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS
ENV NEXTAUTH_URL=$NEXTAUTH_URL
ENV NEXTAUTH_SECRET=$NEXTAUTH_SECRET

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