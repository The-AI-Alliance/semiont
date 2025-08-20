# Frontend Dockerfile for Semiont (Monorepo)
FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json* ./
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/api-types/package.json ./packages/api-types/

# Install all dependencies at root level (this handles workspaces)
RUN npm ci --workspace=apps/frontend --include-workspace-root

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app

# Copy workspace structure
COPY package.json package-lock.json* ./
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/api-types/package.json ./packages/api-types/

# Install all dependencies including dev
RUN npm ci --legacy-peer-deps

# Copy source code for all needed packages
COPY packages/api-types ./packages/api-types
COPY apps/frontend ./apps/frontend

# Build api-types first (if it has a build step)
WORKDIR /app/packages/api-types
RUN npm run build || true

# Build frontend
WORKDIR /app/apps/frontend

# Next.js telemetry
ENV NEXT_TELEMETRY_DISABLED=1

# Accept build arguments for Next.js public environment variables
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_NAME
ARG NEXT_PUBLIC_APP_VERSION

# Set environment variables for build
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_APP_NAME=${NEXT_PUBLIC_APP_NAME}
ENV NEXT_PUBLIC_APP_VERSION=${NEXT_PUBLIC_APP_VERSION}

# Build the application
RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user to own the files and run our server
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 semiont

# Copy Next.js build output
COPY --from=builder --chown=semiont:nodejs /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=semiont:nodejs /app/apps/frontend/.next/static ./.next/static
COPY --from=builder --chown=semiont:nodejs /app/apps/frontend/public ./public

USER semiont

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

CMD ["node", "apps/frontend/server.js"]