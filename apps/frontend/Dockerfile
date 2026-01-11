# Build stage
FROM node:22-alpine AS builder

# Build args to bust cache when version changes
ARG BUILD_VERSION
ARG BUILD_SHA
# Version of @semiont packages to install from npm
ARG SEMIONT_VERSION=latest

WORKDIR /app

# Copy only root package.json and frontend package.json
COPY package.json package-lock.json ./
COPY apps/frontend/package.json ./apps/frontend/

# Install semiont packages from npm at specified version
# This replaces workspace dependencies with published packages
RUN npm install @semiont/api-client@${SEMIONT_VERSION} @semiont/react-ui@${SEMIONT_VERSION} --workspace=apps/frontend

# Install all other dependencies
RUN npm ci

# Copy frontend source only
COPY apps/frontend ./apps/frontend
COPY tsconfig.json ./

# Build frontend (this creates the .next directory with standalone output)
WORKDIR /app/apps/frontend

# Set build-time environment variables
# NEXT_PUBLIC_* variables are embedded in the JavaScript bundle at build time
# and cannot be changed after the container is built (used by browser)
ARG NEXT_PUBLIC_SITE_NAME=Semiont
ARG NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS=example.com

# Runtime-only variables (not embedded in bundle, read by Next.js server)
# These are set as build ARGs with placeholder values to satisfy build-time validation,
# but MUST be overridden via -e when running the container
# - SERVER_API_URL: Internal API URL for server-side calls
# - NEXTAUTH_URL: Frontend URL for OAuth callbacks
# - NEXTAUTH_SECRET: Session encryption secret
# - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: OAuth credentials
ARG SERVER_API_URL=http://placeholder:4000
ARG NEXTAUTH_URL=http://localhost:3000
ARG NEXTAUTH_SECRET=build-time-secret-min-32-chars

ENV NEXT_PUBLIC_SITE_NAME=$NEXT_PUBLIC_SITE_NAME
ENV NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS=$NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS
ENV SERVER_API_URL=$SERVER_API_URL
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