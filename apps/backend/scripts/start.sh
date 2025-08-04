#!/bin/sh
# Production start script for Semiont Backend

set -e

echo "🚀 Starting Semiont Backend..."
echo "Environment: $NODE_ENV"
echo "Port: $PORT"

# Construct DATABASE_URL from individual components if not provided
if [ -z "$DATABASE_URL" ] && [ -n "$DB_HOST" ] && [ -n "$DB_USER" ] && [ -n "$DB_PASSWORD" ]; then
  export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT:-5432}/${DB_NAME}?sslmode=require"
  echo "📊 Constructed DATABASE_URL from components"
fi

# Skip migrations in production for now - run them separately
# TODO: Fix Prisma Alpine compatibility or run migrations in separate job
echo "⚠️  Skipping migrations in production (run separately)"

# Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# Start the server
echo "▶️  Starting server..."
exec node dist/index.js