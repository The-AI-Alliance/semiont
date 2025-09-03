# Backend Dockerfile for Semiont (Monorepo)
# This Dockerfile expects TypeScript to be built locally before the Docker build.
# The build process copies pre-built artifacts instead of compiling in Docker.
FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json* ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/api-types/package.json ./packages/api-types/

# Install all dependencies at root level (this handles workspaces)
RUN npm ci --workspace=apps/backend --include-workspace-root

# Prepare pre-built artifacts
FROM base AS builder
WORKDIR /app

# Copy workspace structure for dependencies
COPY package.json package-lock.json* ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/api-types/package.json ./packages/api-types/

# Install production dependencies only
RUN npm ci --production --legacy-peer-deps

# Copy pre-built artifacts
COPY packages/api-types/dist ./packages/api-types/dist
COPY apps/backend/dist ./apps/backend/dist
COPY apps/backend/prisma ./apps/backend/prisma
COPY apps/backend/scripts ./apps/backend/scripts

# Generate Prisma client (needs to be done after copying schema)
WORKDIR /app/apps/backend
RUN npx prisma generate

# Validate startup script syntax
RUN sh -n ./scripts/start.sh || (echo "❌ SYNTAX ERROR in start.sh" && exit 1)

# Production image, copy all the files and run the app  
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install OpenSSL for Prisma, PostgreSQL client for database access, and curl for health checks
RUN apk add --no-cache openssl postgresql-client curl

# Create a non-root user to own the files and run our server
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 semiont

# Copy the app with dependencies from builder
COPY --from=builder --chown=semiont:nodejs /app ./

# Set working directory for the backend
WORKDIR /app/apps/backend

# Ensure scripts are executable
RUN chmod +x scripts/start.sh || true

# Create uploads directory for EFS mount
RUN mkdir -p /app/uploads && chown semiont:nodejs /app/uploads

USER semiont

EXPOSE 4000

ENV PORT=4000
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:4000/api/health || exit 1

# Use the start script if it exists, otherwise run directly
CMD [ -f "./scripts/start.sh" ] && sh ./scripts/start.sh || node dist/index.js