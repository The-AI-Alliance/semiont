# Local Development Guide

This guide explains how to run Semiont locally for development.

## Prerequisites

- **Node.js** v20 or higher
- **npm** (comes with Node.js)
- **Docker or Podman** (for PostgreSQL and Envoy containers)
- **Git**

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/The-AI-Alliance/semiont.git
cd semiont
```

### 2. Build and Install the CLI

```bash
npm install
npm run build
npm run install:cli
```

### 3. Create Your Project Directory

```bash
cd ..
mkdir my_semiont_project
cd my_semiont_project
```

### 4. Set Environment Variables

```bash
export SEMIONT_REPO=~/path/to/semiont          # Path to the cloned repository
export SEMIONT_ROOT=$(pwd)                      # Path to your project directory
export SEMIONT_ENV=local                        # Target environment
```

> **Important**: `SEMIONT_ROOT` tells the CLI where your project is located, so you can run commands from any directory. `SEMIONT_REPO` points to the cloned source repository.

### 5. Initialize the Project

```bash
semiont init
```

This creates `semiont.json` and `environments/local.json` in your project directory.

### 6. Review the Configuration

```bash
cat environments/local.json
```

This file defines all services (backend, frontend, database, proxy, etc.) and their configuration. Edit it to set Neo4j credentials, Anthropic API key, or adjust ports.

### 7. Provision Services

```bash
semiont provision
```

This generates `.env` files for the backend and frontend, processes proxy configuration, and pushes the database schema.

### 8. Start Services

```bash
semiont start
```

This starts the database container, backend, frontend, and Envoy proxy.

### 9. Verify Everything is Running

```bash
semiont check
```

### 10. Create an Admin User

```bash
semiont useradd --email you@example.com --generate-password --admin
```

Note the generated password from the output.

### 11. Check the Logs

```bash
tail -f apps/backend/logs/combined.log
```

### 12. Access the Application

Open http://localhost:8080 in your browser and log in with the admin credentials from step 10.

## Service Ports

| Service | Port | URL |
|---------|------|-----|
| Envoy Proxy | 8080 | http://localhost:8080 (main entry point) |
| Frontend | 3000 | http://localhost:3000 (direct) |
| Backend | 4000 | http://localhost:4000 (direct) |
| PostgreSQL | 5432 | postgresql://localhost:5432 |

## Common Tasks

### Start/Stop Services

```bash
semiont start --service backend
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
