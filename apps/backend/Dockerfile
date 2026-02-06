# Build stage
FROM node:22-alpine AS builder

# Build args to bust cache when version changes
ARG BUILD_VERSION
ARG BUILD_SHA
# Version of @semiont packages to install from npm
ARG SEMIONT_VERSION=latest

WORKDIR /app

# Copy only root package.json and backend package.json
COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/

# Install semiont packages from npm at specified version first
# This replaces workspace dependencies with published packages
RUN npm install \
  @semiont/api-client@${SEMIONT_VERSION} \
  @semiont/content@${SEMIONT_VERSION} \
  @semiont/core@${SEMIONT_VERSION} \
  @semiont/event-sourcing@${SEMIONT_VERSION} \
  @semiont/graph@${SEMIONT_VERSION} \
  @semiont/inference@${SEMIONT_VERSION} \
  @semiont/jobs@${SEMIONT_VERSION} \
  @semiont/make-meaning@${SEMIONT_VERSION} \
  @semiont/ontology@${SEMIONT_VERSION} \
  --workspace=apps/backend

# Then install all other dependencies
# Use npm install (not npm ci) because package-lock.json is now out of sync
RUN npm install --workspace=apps/backend

# Copy backend source only
COPY apps/backend ./apps/backend
COPY tsconfig.json ./

# Copy and build OpenAPI spec (required for validation)
COPY specs ./specs
RUN npm run openapi:bundle

# Build backend application
WORKDIR /app/apps/backend
RUN npm run build

# Production stage
FROM node:22-alpine

# Version of @semiont packages to install from npm
ARG SEMIONT_VERSION=latest

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/

# Install semiont packages from npm at specified version first
RUN npm install \
  @semiont/api-client@${SEMIONT_VERSION} \
  @semiont/content@${SEMIONT_VERSION} \
  @semiont/core@${SEMIONT_VERSION} \
  @semiont/event-sourcing@${SEMIONT_VERSION} \
  @semiont/graph@${SEMIONT_VERSION} \
  @semiont/inference@${SEMIONT_VERSION} \
  @semiont/jobs@${SEMIONT_VERSION} \
  @semiont/make-meaning@${SEMIONT_VERSION} \
  @semiont/ontology@${SEMIONT_VERSION} \
  --workspace=apps/backend

# Then install all other production dependencies
# Use npm install (not npm ci) because package-lock.json is now out of sync
RUN npm install --omit=dev --workspace=apps/backend

# Copy built artifacts from builder
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist

# Copy generated OpenAPI spec from builder
COPY --from=builder /app/specs/openapi.json ./specs/openapi.json

# Copy Prisma schema and generate client
COPY --from=builder /app/apps/backend/prisma ./apps/backend/prisma
WORKDIR /app/apps/backend
RUN npx prisma generate

# Copy startup scripts if they exist
COPY --from=builder /app/apps/backend/scripts ./scripts

# Install runtime dependencies
RUN apk add --no-cache openssl postgresql-client curl

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

# Create uploads directory
RUN mkdir -p /app/uploads && chown semiont:nodejs /app/uploads

# Set ownership
RUN chown -R semiont:nodejs /app

USER semiont

# Expose port
EXPOSE 4000

ENV NODE_ENV=production
ENV PORT=4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:4000/api/health || exit 1

# Run the application
CMD ["node", "dist/index.js"]
