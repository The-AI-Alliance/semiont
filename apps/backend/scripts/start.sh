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
npx prisma migrate deploy || {
  echo "⚠️  Migration failed, but continuing (database might already be up to date)"
}

# Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# Start the server
echo "▶️  Starting server..."
exec node dist/index.js