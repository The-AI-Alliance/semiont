# Semiont Development Container

This directory contains the configuration for GitHub Codespaces and VS Code Dev Containers, providing a fully configured development environment for Semiont.

## Quick Start

### GitHub Codespaces (Recommended)

1. **Launch Codespace**: Click the button below or go to the repository and click "Code" → "Codespaces" → "Create codespace on main"

   [![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new/The-AI-Alliance/semiont)

2. **Configure Secrets**: For AI features and graph database support, configure these secrets in your GitHub settings ([Settings → Codespaces → Secrets](https://github.com/settings/codespaces)):

   - `ANTHROPIC_API_KEY` - Your Anthropic API key for AI features
   - `NEO4J_URI` - Neo4j connection URI (e.g., `neo4j+s://xxxxx.databases.neo4j.io`)
   - `NEO4J_USERNAME` - Neo4j username (usually `neo4j`)
   - `NEO4J_PASSWORD` - Neo4j password
   - `NEO4J_DATABASE` - Neo4j database name (usually `neo4j`)

3. **Wait for Setup**: The `postCreateCommand` runs `setup.sh` automatically. This:
   - Installs npm dependencies and builds packages
   - Installs Envoy proxy and the Semiont CLI globally
   - Creates Semiont project configuration
   - Provisions backend, frontend, and proxy services
   - Pushes database schema and creates an admin user
   - Saves credentials to `/workspace/credentials.json`

4. **Make Port Public**: In VS Code, open the Ports panel (View → Ports) and make port **8080** public:
   - Right-click port 8080 → Port Visibility → Public

5. **Start Services**:

   ```bash
   semiont start
   ```

6. **Verify Setup**: Check that all services are running:

   ```bash
   semiont check
   ```

7. **Access the Application**: Browse to the public URL for port 8080 (shown in Ports panel). Login credentials are in `/workspace/credentials.json`.

### VS Code Dev Containers (Local)

1. **Prerequisites**:
   - Docker Desktop or Podman installed and running
   - VS Code with the "Dev Containers" extension

2. **Environment Variables**: Create a `.env` file in the `.devcontainer` directory:

   ```bash
   ANTHROPIC_API_KEY=your-api-key
   NEO4J_URI=neo4j+s://xxxxx.databases.neo4j.io
   NEO4J_USERNAME=neo4j
   NEO4J_PASSWORD=your-password
   NEO4J_DATABASE=neo4j
   ```

3. **Open in Container**:
   - Open the repository in VS Code
   - Press `F1` and select "Dev Containers: Reopen in Container"
   - Wait for the container to build and `setup.sh` to complete
   - Follow steps 5-7 from the Codespaces instructions above

## How It Works

### Architecture

Semiont uses a **CLI-driven architecture** where:

- **`semiont init`**: Creates project configuration (`semiont.json`, environment files)
- **`semiont provision`**: Sets up services (database schema, environment variables, proxy config)
- **`semiont start`**: Starts services in the background
- **`semiont check`**: Verifies service health
- **`semiont stop`**: Stops running services

### Configuration System

Configuration flows from **Semiont config → environment variables** at provision-time:

1. **Environment Files** (`environments/*.json`):
   - Define service configurations per environment (local, staging, production)
   - Specify backend URL, database settings, OAuth domains, etc.

2. **Provision Step** (`semiont provision --service frontend`):
   - Reads environment config
   - Writes `NEXT_PUBLIC_*` variables to `.env.local`
   - Frontend syncs with config at provision-time, not start-time

3. **Start Step** (`semiont start --service frontend`):
   - Reads environment variables from `.env.local`
   - No config file loading at runtime
   - Clean separation of concerns

### Services

- **PostgreSQL 16**: Local database (connection: `postgresql://semiont:semiont@localhost:5432/semiont`)
- **Backend API** (port 4000): Hono.js server with Prisma ORM
- **Frontend** (port 3000): Next.js 15 with NextAuth authentication
- **Envoy Proxy** (port 8080): Path-based routing to backend and frontend

### Authentication

- **Password Auth**: Email/password authentication (always available)
- **OAuth**: Google OAuth for production environments
- **Configuration**: Controlled via `NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS`

## What's Included

### VS Code Extensions

- **Code Quality**: ESLint, Prettier, Error Lens, Pretty TypeScript Errors
- **Productivity**: GitHub Copilot, Path Intellisense, NPM Intellisense
- **Framework Support**: Prisma, Tailwind CSS, Docker

### Tools

- GitHub CLI, Git, PostgreSQL Client, Docker-in-Docker
- Node.js 22 LTS
- Envoy Proxy
- Semiont CLI (globally installed)

## Common Commands

```bash
# Semiont CLI
semiont start                         # Start all services
semiont check                         # Check service status
semiont stop                          # Stop all services
semiont stop --service frontend       # Stop a single service
semiont provision --service frontend  # Re-provision frontend

# Database operations
cd apps/backend
npm run db:studio                     # Open Prisma Studio (port 5555)
npm run db:push                       # Push schema changes

# Development
npm run test                          # Run all tests
npm run build                         # Build all packages
```

For demos and examples, see the [Semiont Workflows Demo](https://github.com/The-AI-Alliance/semiont-workflows) repository.

## Troubleshooting

### Services won't start

```bash
# Check service status
semiont check

# View logs
tail -f apps/backend/logs/app.log
tail -f apps/frontend/logs/app.log

# Re-provision if needed
semiont provision --service backend --force
semiont provision --service frontend --force
```

### Port visibility issues

- Ensure port 8080 is set to **Public** in the Ports panel
- If using Codespaces, check the forwarded URL in the Ports panel

### Database connection errors

- Verify PostgreSQL is running: `docker ps`
- Check DATABASE_URL in `apps/backend/.env`
- Restart: `semiont stop --service backend && semiont start --service backend`

### Authentication not working

- Verify backend is running on port 4000
- Check frontend can reach backend via `SERVER_API_URL` in `apps/frontend/.env.local`
- Clear browser cookies and retry

## Resources

- [GitHub Codespaces Documentation](https://docs.github.com/en/codespaces)
- [VS Code Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers)
- [Semiont Documentation](/workspace/README.md)
- [API Documentation](http://localhost:4000/docs) (when backend is running)
