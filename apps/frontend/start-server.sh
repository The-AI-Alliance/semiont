#!/bin/sh
# Wrapper script to ensure environment variables are available to Next.js server

# Export all environment variables that the auth system needs
# These are provided by ECS task definition but need to be explicitly available
# to the Next.js server-side code

# Debug: Show that the environment variable is set
echo "Starting Next.js server with OAUTH_ALLOWED_DOMAINS=${OAUTH_ALLOWED_DOMAINS}"

# Start the Next.js standalone server
# The environment variables are already in the process environment,
# but we need to ensure they're passed through to the Node.js process
exec node apps/frontend/server.js