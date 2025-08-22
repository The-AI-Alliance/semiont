# Backend Dockerfile for Semiont (Monorepo)
# IMPORTANT: When using --no-cache, pass --build-arg CACHE_BUST=$(date +%s) to force full rebuild
ARG CACHE_BUST=1

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

# Rebuild the source code only when needed
FROM base AS builder
# Inherit cache buster to ensure builder rebuilds when needed
ARG CACHE_BUST
RUN echo "Builder stage cache bust: ${CACHE_BUST:-default}"

WORKDIR /app

# Copy workspace structure
COPY package.json package-lock.json* ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/api-types/package.json ./packages/api-types/

# Install all dependencies including dev
RUN npm ci

# Copy source code for all needed packages
COPY packages/api-types ./packages/api-types
COPY apps/backend ./apps/backend

# Validate startup script syntax at build time
RUN sh -n ./apps/backend/scripts/start.sh || (echo "❌ SYNTAX ERROR in start.sh" && exit 1)

# Build packages in dependency order
WORKDIR /app/packages/api-types
RUN npm run build || true

# Build backend
WORKDIR /app/apps/backend

# Generate Prisma client
RUN npx prisma generate

# Build the application
RUN npm run build

# Production image, copy all the files and run the app  
FROM base AS runner
# Inherit cache buster to ensure runner rebuilds when builder changes
ARG CACHE_BUST
RUN echo "Runner stage cache bust: ${CACHE_BUST:-default}"

WORKDIR /app

ENV NODE_ENV=production

# Install OpenSSL for Prisma and PostgreSQL client for database access
RUN apk add --no-cache openssl postgresql-client

# Create a non-root user to own the files and run our server
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 semiont

# Copy built application and dependencies
COPY --from=builder --chown=semiont:nodejs /app/apps/backend/dist ./dist
COPY --from=builder --chown=semiont:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=semiont:nodejs /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=builder --chown=semiont:nodejs /app/packages/api-types ./packages/api-types
COPY --from=builder --chown=semiont:nodejs /app/apps/backend/package.json ./package.json

# Copy Prisma files for migrations
COPY --from=builder --chown=semiont:nodejs /app/apps/backend/prisma ./prisma

# Copy start script (create dummy if doesn't exist)
RUN mkdir -p /app/apps/backend/scripts && touch /app/apps/backend/scripts/start.sh || true
COPY --from=builder --chown=semiont:nodejs /app/apps/backend/scripts/ ./scripts/
RUN chmod +x scripts/start.sh || true

# Create uploads directory for EFS mount
RUN mkdir -p /app/uploads && chown semiont:nodejs /app/uploads

USER semiont

EXPOSE 4000

ENV PORT=4000
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Use the start script if it exists, otherwise run directly
CMD [ -f "./scripts/start.sh" ] && sh ./scripts/start.sh || node dist/index.js