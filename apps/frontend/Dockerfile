# Frontend Dockerfile for Semiont (Monorepo)
# Using Next.js standalone output for optimized production deployment
FROM node:22-alpine AS base

# Production runner stage
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install curl for health checks
RUN apk add --no-cache curl

# Create a non-root user to own the files and run our server
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 semiont

# Copy the standalone server files
# The standalone output includes all necessary dependencies
COPY --chown=semiont:nodejs apps/frontend/.next/standalone ./
# Static files must be in the .next directory relative to where server.js runs
COPY --chown=semiont:nodejs apps/frontend/.next/static ./apps/frontend/.next/static  
# Public files should be at the same level as .next
COPY --chown=semiont:nodejs apps/frontend/public ./apps/frontend/public
# Copy the start script
COPY --chown=semiont:nodejs apps/frontend/start-server.sh ./start-server.sh
RUN chmod +x ./start-server.sh

USER semiont

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Health check - check root path to match ALB configuration
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Run the standalone server via wrapper script to ensure env vars are available
# The wrapper script ensures runtime environment variables are passed to Next.js
CMD ["./start-server.sh"]