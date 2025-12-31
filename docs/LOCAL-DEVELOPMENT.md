# Local Development Guide

This guide explains how to run Semiont locally for development.

## Prerequisites

- **Node.js** v20 or higher
- **npm** (comes with Node.js)
- **Docker or Podman** (for PostgreSQL container)
- **Git**

## Initial Setup

### 1. Clone and Build Semiont Repository

```bash
git clone https://github.com/The-AI-Alliance/semiont.git
cd semiont
export SEMIONT_REPO=$(pwd)
npm install
npm run build
npm run install:cli
```

### 2. Create Your Project Directory

```bash
cd ..
mkdir my_semiont_project
cd my_semiont_project
export SEMIONT_ROOT=$(pwd)
export SEMIONT_ENV=local

semiont init
```

> **Important**: The `SEMIONT_ROOT` environment variable tells the CLI where your project is located, so you can run commands from any directory.

## Quick Start

Start all services:

```bash
semiont start --all
```

Or start services individually:

```bash
# 1. Start database
semiont start --service database

# 2. Provision and start backend with admin user
semiont provision --service backend --seed-admin --admin-email dev@example.com
semiont start --service backend

# 3. Provision and start frontend
semiont provision --service frontend
semiont start --service frontend

# 4. Check status
semiont check
```

## Access the Application

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:4000
- **API Documentation**: http://localhost:4000/api

For local development, sign in with the email you used during backend provisioning (e.g., `dev@example.com`). No password required.

## Service Ports

| Service | Port | URL |
|---------|------|-----|
| Frontend | 3000 | http://localhost:3000 |
| Backend | 4000 | http://localhost:4000 |
| PostgreSQL | 5432 | postgresql://localhost:5432 |

## Common Tasks

### Start/Stop Services

```bash
semiont start --service backend
semiont start --service frontend
semiont stop --service backend
semiont check
```

### Database Operations

```bash
cd apps/backend
npx prisma studio          # Open Prisma Studio GUI
npx prisma migrate dev     # Run migrations
npx prisma generate        # Generate Prisma Client
```

### Re-provision After Config Changes

```bash
semiont provision --service frontend  # Updates .env.local from config
semiont provision --service backend   # Updates backend configuration
```

## Configuration

The frontend syncs configuration from Semiont environment files at provision-time. After changing environment config, re-run `semiont provision --service frontend` to update `.env.local`.

Key environment variables:

- `SERVER_API_URL` - Backend API URL (from `services.backend.publicURL`)
- `NEXT_PUBLIC_SITE_NAME` - Site name (from `services.frontend.siteName`)
- `NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS` - Allowed OAuth domains (from `site.oauthAllowedDomains`)

See [CONFIGURATION.md](./CONFIGURATION.md) for complete environment variable reference.

## Additional Documentation

- **[AUTHENTICATION.md](./AUTHENTICATION.md)** - Authentication setup, OAuth configuration, admin users
- **[CONFIGURATION.md](./CONFIGURATION.md)** - Environment variables, service configuration
- **[TESTING.md](./TESTING.md)** - Running tests, test commands
- **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** - Common issues, port conflicts, database problems
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - System architecture, component overview
- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Production deployment

## Getting Help

1. Check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
2. Search [GitHub Issues](https://github.com/The-AI-Alliance/semiont/issues)
3. Create a new issue with reproduction steps and error messages
