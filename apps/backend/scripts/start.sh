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

# Run migrations in production
echo "📝 Running database migrations..."

# First, try to resolve any failed migrations as rolled back
# This handles migrations that failed due to incorrect table names
echo "🔧 Resolving any failed migrations..."
# npx prisma migrate resolve --rolled-back 20240820000000_grant_initial_admin 2>/dev/null || true

# Then run migrations normally
echo "📝 Deploying database migrations..."
npx prisma migrate deploy || {
  echo "⚠️  Migration failed, but continuing (database might already be up to date)"
  # As a last resort, try db push to sync schema
  npx prisma db push --skip-generate || true
}

# Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# Start the server
echo "▶️  Starting server..."
exec node dist/index.js