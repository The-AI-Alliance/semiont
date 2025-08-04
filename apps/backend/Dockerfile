# Backend Dockerfile for Semiont
FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app

# Install all dependencies (including dev) for build
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build the application
RUN npm run build

# Production image, copy all the files and run the app
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install OpenSSL for Prisma and PostgreSQL client for database access
RUN apk add --no-cache openssl postgresql-client

# Create a non-root user to own the files and run our server
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 semiont

# Copy the built application from the builder stage
COPY --from=builder --chown=semiont:nodejs /app/dist ./dist
COPY --from=deps --chown=semiont:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=semiont:nodejs /app/package.json ./package.json

# Copy Prisma files for client generation and migrations
COPY --from=builder --chown=semiont:nodejs /app/prisma ./prisma

# Copy start script
COPY --from=builder --chown=semiont:nodejs /app/scripts ./scripts
RUN chmod +x scripts/start.sh

# Create uploads directory for EFS mount
RUN mkdir -p /app/uploads && chown semiont:nodejs /app/uploads

USER semiont

EXPOSE 4000

ENV PORT=4000
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

CMD ["sh", "./scripts/start.sh"]