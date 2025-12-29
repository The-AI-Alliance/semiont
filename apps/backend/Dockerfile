# Build stage
FROM node:22-alpine AS builder

# Build args to bust cache when version changes
ARG BUILD_VERSION
ARG BUILD_SHA

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/core/package.json ./packages/core/
COPY packages/api-client/package.json ./packages/api-client/

# Install all dependencies
RUN npm ci

# Copy source files
COPY apps/backend ./apps/backend
COPY packages/core ./packages/core
COPY packages/api-client ./packages/api-client
COPY specs ./specs
COPY tsconfig.json ./

# Build packages and application
RUN npm run build -w packages/api-client
RUN npm run build -w packages/core
RUN npm run build -w apps/backend

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/core/package.json ./packages/core/
COPY packages/api-client/package.json ./packages/api-client/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built artifacts from builder
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/api-client/dist ./packages/api-client/dist

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
