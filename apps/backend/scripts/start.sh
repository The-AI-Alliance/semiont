#!/bin/sh
# Production start script for Semiont Backend

# Exit on error, but also show which line failed
set -e

# Write startup status to a file that health checks can read
STARTUP_STATUS_FILE="/tmp/startup_status"
echo "STARTING" > $STARTUP_STATUS_FILE

# Trap errors and show where they occurred
trap 'echo "❌ FATAL STARTUP ERROR: Script failed at line $LINENO with exit code $?" >&2; echo "FAILED: Script error at line $LINENO" > $STARTUP_STATUS_FILE; exit 1' ERR

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

# Note: DATABASE_URL will be constructed in Node.js if needed
# Migrations will be handled separately (not on every startup)

# Start the server
echo "▶️  Starting server..."
echo "SUCCESS" > $STARTUP_STATUS_FILE
exec node dist/index.js