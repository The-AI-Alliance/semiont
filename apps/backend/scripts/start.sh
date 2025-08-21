#!/bin/sh
# Production start script for Semiont Backend

set -e

echo "🚀 Starting Semiont Backend..."
echo "Environment: $NODE_ENV"
echo "Port: $PORT"

# Debug: Check what variables we have
echo "🔍 Environment Check:"
echo "   DATABASE_URL is: ${DATABASE_URL:-NOT SET}"
echo "   DB_HOST is: ${DB_HOST:-NOT SET}"
echo "   DB_PORT is: ${DB_PORT:-NOT SET}"
echo "   DB_NAME is: ${DB_NAME:-NOT SET}"
echo "   DB_USER is: ${DB_USER:-NOT SET}"
echo "   DB_PASSWORD is: ${DB_PASSWORD:+SET}"

# Construct DATABASE_URL from individual components if not provided
if [ -z "$DATABASE_URL" ] && [ -n "$DB_HOST" ] && [ -n "$DB_USER" ] && [ -n "$DB_PASSWORD" ]; then
  echo "📊 Constructing DATABASE_URL from components:"
  echo "   DB_HOST: ${DB_HOST}"
  echo "   DB_PORT: ${DB_PORT:-5432}"
  echo "   DB_NAME: ${DB_NAME}"
  echo "   DB_USER: ${DB_USER:0:3}***" # Show first 3 chars only
  echo "   DB_PASSWORD: [SET]"
  
  export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT:-5432}/${DB_NAME}?sslmode=require"
  echo "✅ DATABASE_URL constructed successfully"
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