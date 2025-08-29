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

# Copy workspace structure for production dependencies only
COPY package.json package-lock.json* ./
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/api-types/package.json ./packages/api-types/

# Install all dependencies (Next.js needs some dev deps at runtime)
RUN npm ci --legacy-peer-deps

# Copy pre-built api-types (if it exists)
COPY packages/api-types/dist* ./packages/api-types/

# Copy pre-built frontend application and required files
COPY apps/frontend/.next ./apps/frontend/.next
COPY apps/frontend/public ./apps/frontend/public
COPY apps/frontend/next.config.js ./apps/frontend/next.config.js
COPY apps/frontend/package.json ./apps/frontend/package.json

# Set working directory for the app
WORKDIR /app/apps/frontend

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user to own the files and run our server
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 semiont

# Copy the app with dependencies
COPY --from=builder --chown=semiont:nodejs /app ./

USER semiont

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Set working directory
WORKDIR /app/apps/frontend

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Use Next.js production server
CMD ["npx", "next", "start"]