# Local Development Guide

This guide explains how to run Semiont locally for development, including the frontend document editing interface and backend API.

## Prerequisites

Before starting, ensure you have the following installed:

- **Node.js** v18 or higher
- **npm** (comes with Node.js)
- **Docker or Podman** (for PostgreSQL and JanusGraph containers)
- **Git**

> **Note**: This guide uses `docker` commands, but Podman is fully compatible. Simply replace `docker` with `podman` in all commands, or create an alias: `alias docker=podman`

## Quick Start

The fastest way to start all services:

```bash
# From project root
semiont start --all --environment local
```

This starts all services defined in `apps/cli/templates/environments/local.json`.

## Manual Setup

If you prefer to start services individually or need more control:

### Step 1: Provision and Start PostgreSQL Database

```bash
# Option A: Using Semiont CLI (recommended)
# First provision the database (creates volume, pulls image, runs init scripts)
semiont provision --service database --environment local

# Then start the database
semiont start --service database --environment local

# Option B: Using Docker/Podman directly
docker run -d \
  --name semiont-local-db \
  -e POSTGRES_DB=semiont \
  -e POSTGRES_USER=semiont \
  -e POSTGRES_PASSWORD=localpass \
  -p 5432:5432 \
  postgres:15-alpine

# For Podman users: The exact same command works with 'podman' instead of 'docker'
```

> **Note**: The provision step creates persistent volumes and prepares the database. If you have initialization scripts in `db/init/`, they will run on first start. Migration scripts in `db/migrations/` and seed data in `db/seed/` can be run by your application.

### Step 2: Provision and Start JanusGraph (Optional)

Required only if you're working with graph database features:

```bash
# Option A: Using Semiont CLI
# First provision JanusGraph (creates docker-compose configuration)
semiont provision --service graph --environment local

# Optionally provision with Elasticsearch and/or Cassandra backends
# semiont provision --service graph --environment local -- --with-elasticsearch
# semiont provision --service graph --environment local -- --with-cassandra

# Then start the graph database
semiont start --service graph --environment local

# Option B: Using Docker/Podman directly
docker run -d \
  --name janusgraph \
  -p 8182:8182 \
  janusgraph/janusgraph:latest

# For Podman users: Same command with 'podman' instead of 'docker'
```

### Step 3: Provision and Start Filesystem Storage

The filesystem service provides shared storage for uploads, caching, and temporary files:

```bash
# Provision the filesystem (creates directory structure)
semiont provision --service filesystem --environment local

# Start the filesystem service (ensures it's accessible and ready)
semiont start --service filesystem --environment local

# Check filesystem status
semiont check --service filesystem --environment local

# When done, stop and optionally clean temporary files
# semiont stop --service filesystem --environment local --clean
```

> **Note**: The filesystem service is passive storage (not a running process). The "start" command simply ensures the directories exist and are accessible. Other services can mount this filesystem for shared storage needs.

### Step 4: Setup and Run Backend

```bash
cd apps/backend

# Install dependencies
npm install

# Set database connection
export DATABASE_URL="postgresql://semiont:localpass@localhost:5432/semiont"

# Run database migrations
npx prisma migrate dev

# Generate Prisma client
npx prisma generate

# Start backend in development mode (with hot reload)
npm run dev
```

The backend API will be available at **http://localhost:4000**

Backend endpoints:
- API Documentation: http://localhost:4000/api
- Health Check: http://localhost:4000/health
- OpenAPI Spec: http://localhost:4000/doc

### Step 5: Setup and Run Frontend

Open a new terminal window:

```bash
cd apps/frontend

# Install dependencies
npm install

# Create environment configuration
cat > .env.local << EOF
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-key-at-least-32-chars-long-change-this
EOF

# Start frontend in development mode (with hot reload)
npm run dev

# For faster builds with Turbo mode:
# npm run dev:fast

# To run with mock data (no backend required):
# npm run dev:mock
```

The frontend will be available at **http://localhost:3000**

## Available Features

Once running, you can access the following features:

### Document Management
1. **View Documents**: Browse existing documents in the list view
2. **Create Documents**: Click "New Document" to create new content
3. **Edit Documents**: Full markdown editor with live preview
4. **Wiki Links**: Use `[[Page Name]]` syntax for cross-references
5. **Search**: Search documents by name and content

### Selection System
1. **Text Highlights**: Select text to highlight important sections
2. **References**: Create links between documents
3. **Entity References**: Tag entities with semantic types
4. **Provisional Selections**: Mark temporary selections for later resolution

### Authentication
- Google OAuth integration (requires configuration)
- Session-based authentication
- Admin user management

## Default Service Ports

| Service | Port | URL/Path |
|---------|------|----------|
| Frontend | 3000 | http://localhost:3000 |
| Backend | 4000 | http://localhost:4000 |
| PostgreSQL | 5432 | postgresql://localhost:5432 |
| JanusGraph | 8182 | ws://localhost:8182/gremlin |
| Filesystem | - | ./data/uploads (local path) |

## Environment Configuration

The local environment is configured in `apps/cli/templates/environments/local.json`:

- **Frontend**: Runs as native process (POSIX platform)
- **Backend**: Runs as native process (POSIX platform)
- **Database**: Runs in Docker/Podman container
- **Graph**: Runs in Docker/Podman container (JanusGraph)
- **Filesystem**: Local directory storage (POSIX platform)

## Development Commands

### Backend Commands
```bash
cd apps/backend

npm run dev          # Start with hot reload
npm run build        # Build for production
npm run test         # Run tests
npm run test:watch   # Run tests in watch mode
npm run typecheck    # Check TypeScript types
```

### Frontend Commands
```bash
cd apps/frontend

npm run dev          # Start with hot reload
npm run dev:fast     # Start with Turbo mode
npm run dev:mock     # Start with mock backend
npm run build        # Build for production
npm run test         # Run tests
npm run typecheck    # Check TypeScript types
```

### Database Commands
```bash
cd apps/backend

npx prisma migrate dev     # Run migrations
npx prisma studio          # Open Prisma Studio GUI
npx prisma generate        # Generate Prisma Client
npx prisma migrate reset   # Reset database
```

## Troubleshooting

### Port Already in Use

Kill processes using specific ports:

```bash
# Frontend (port 3000)
lsof -ti:3000 | xargs kill -9

# Backend (port 4000)
lsof -ti:4000 | xargs kill -9

# PostgreSQL (port 5432)
lsof -ti:5432 | xargs kill -9
```

### Database Connection Issues

Check if PostgreSQL is running:

```bash
# Check container status
docker ps | grep semiont-local-db  # or: podman ps | grep semiont-local-db

# View container logs
docker logs semiont-local-db  # or: podman logs semiont-local-db

# Test connection
psql postgresql://semiont:localpass@localhost:5432/semiont
```

### Module Not Found Errors

Rebuild shared packages:

```bash
# From project root
npm run build --workspace=@semiont/api-types

# Or rebuild everything
npm install
npm run build
```

### Authentication Issues

1. Ensure `NEXTAUTH_SECRET` is set in `apps/frontend/.env.local`
2. Verify backend is running on port 4000
3. Check browser console for CORS errors
4. Clear browser cookies and local storage

### Graph Database Issues

Check JanusGraph container:

```bash
# Check container status
docker ps | grep janusgraph  # or: podman ps | grep janusgraph

# View container logs
docker logs janusgraph  # or: podman logs janusgraph

# Test Gremlin connection
curl http://localhost:8182/gremlin
```

## Development Tips

### Hot Reload
Both frontend and backend support automatic reloading when files change. No need to restart services during development.

### TypeScript
The project uses strict TypeScript. Run `npm run typecheck` before committing to catch type errors.

### API Types
Shared API types are in `packages/api-types`. After changing these, rebuild:

```bash
npm run build --workspace=@semiont/api-types
```

### Database Migrations
When changing the schema:

1. Edit `apps/backend/prisma/schema.prisma`
2. Run `npx prisma migrate dev --name your-migration-name`
3. Commit both schema and migration files

### Testing
Run tests before committing:

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit
npm run test:integration
npm run test:api
```

### Debugging

#### Backend Debugging
Add `console.log()` statements or use Node.js debugger:

```bash
# Start with inspector
node --inspect dist/index.js

# Or use VS Code debugger with provided launch.json
```

#### Frontend Debugging
- Use browser DevTools
- React Developer Tools extension
- Network tab for API calls
- Console for client-side errors

## Using Mock Data

To run frontend without backend:

```bash
cd apps/frontend
npm run dev:mock
```

This uses MSW (Mock Service Worker) to intercept API calls and return mock data.

## Environment Variables

### Backend Environment Variables
- `DATABASE_URL`: PostgreSQL connection string
- `PORT`: API server port (default: 4000)
- `NODE_ENV`: Environment (development/production)
- `JWT_SECRET`: Secret for JWT tokens
- `GRAPH_TYPE`: Graph database type (janusgraph/neptune)

### Frontend Environment Variables
- `NEXT_PUBLIC_API_URL`: Backend API URL
- `NEXTAUTH_URL`: Frontend URL for authentication
- `NEXTAUTH_SECRET`: Secret for NextAuth.js
- `GOOGLE_CLIENT_ID`: Google OAuth client ID (optional)
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret (optional)

## Additional Resources

- [Architecture Overview](./ARCHITECTURE.md)
- [API Documentation](./API.md)
- [Deployment Guide](./DEPLOYMENT.md)
- [Contributing Guidelines](../CONTRIBUTING.md)

## Getting Help

If you encounter issues:

1. Check the [troubleshooting section](#troubleshooting) above
2. Search existing [GitHub Issues](https://github.com/The-AI-Alliance/semiont/issues)
3. Create a new issue with:
   - Steps to reproduce
   - Error messages
   - Environment details (OS, Node version, etc.)

## Next Steps

Once your local environment is running:

1. Explore the document editing interface
2. Create and link documents using wiki syntax
3. Test the selection and highlighting features
4. Review the API documentation at http://localhost:4000/api
5. Start contributing!