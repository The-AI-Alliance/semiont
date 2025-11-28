# Semiont Development Container

This directory contains the configuration for GitHub Codespaces and VS Code Dev Containers, providing a fully configured development environment for Semiont.

## 🚀 Quick Start

### GitHub Codespaces (Recommended)

1. **Launch Codespace**: Click the button below or go to the repository and click "Code" → "Codespaces" → "Create codespace on main"

   [![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new/The-AI-Alliance/semiont)

2. **Configure Secrets** (Optional): For AI features and graph database support, configure these secrets in your GitHub settings ([Settings → Codespaces → Secrets](https://github.com/settings/codespaces)):

   - `ANTHROPIC_API_KEY` - Your Anthropic API key for AI features
   - `NEO4J_URI` - Neo4j connection URI (e.g., `neo4j+s://xxxxx.databases.neo4j.io`)
   - `NEO4J_USERNAME` - Neo4j username (usually `neo4j`)
   - `NEO4J_PASSWORD` - Neo4j password
   - `NEO4J_DATABASE` - Neo4j database name (usually `neo4j`)

3. **Initial Setup**: After the Codespace starts, run the post-create script to complete setup:

   ```bash
   bash .devcontainer/post-create.sh
   ```

   This script:
   - Installs npm dependencies and builds packages
   - Installs the Semiont CLI globally
   - Creates Semiont project configuration
   - Provisions backend database and frontend
   - Creates `.env` files with defaults

4. **Make Ports Public**: In VS Code, open the Ports panel (View → Ports) and make ports **3000** and **4000** public:
   - Right-click port 3000 → Port Visibility → Public
   - Right-click port 4000 → Port Visibility → Public

5. **Start Services**: Use the Semiont CLI to start services:

   ```bash
   semiont start --service backend
   semiont start --service frontend
   ```

6. **Verify Setup**: Check that all services are running:

   ```bash
   semiont check
   ```

   You should see:
   - Backend: `running` on port 4000
   - Frontend: `running` on port 3000

7. **Access the Application**: Browse to the public URL for port 3000 (shown in Ports panel) and login with:
   - Email: `dev@example.com`

### VS Code Dev Containers (Local)

1. **Prerequisites**:
   - Docker Desktop installed and running
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
   - Wait for the container to build and initialize
   - Follow steps 3-7 from the Codespaces instructions above

## 🏗️ How It Works

### Architecture

Semiont uses a **CLI-driven architecture** where:
- **`semiont init`**: Creates project configuration (`semiont.json`, environment files)
- **`semiont provision`**: Sets up services (database schema, environment variables)
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

### Authentication

- **Local Development**: Email-only auth (no password) via `dev@example.com`
- **OAuth**: Google OAuth for production environments
- **Configuration**: Controlled via `NEXT_PUBLIC_ENABLE_LOCAL_AUTH` and `NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS`

## 📦 What's Included

### VS Code Extensions

- **Code Quality**: ESLint, Prettier, Error Lens, Pretty TypeScript Errors
- **Productivity**: GitHub Copilot, Path Intellisense, NPM Intellisense
- **Framework Support**: Prisma, Tailwind CSS, Docker

### Tools

- GitHub CLI, Git, PostgreSQL Client, Docker-in-Docker
- Node.js 22 LTS
- Semiont CLI (globally installed)

## 📝 Common Commands

```bash
# Semiont CLI
semiont check                      # Check service status
semiont start --service backend    # Start backend
semiont start --service frontend   # Start frontend
semiont stop --service frontend    # Stop frontend
semiont provision --service frontend  # Re-provision frontend

# Database operations
cd apps/backend
npm run db:studio                 # Open Prisma Studio (port 5555)
npm run db:push                   # Push schema changes

# Development
npm run test                      # Run all tests
npm run build                     # Build all packages

# Demo Scripts
cd demo
npm run demo:interactive          # Interactive demo menu
```

See [demo/README.md](../demo/README.md) for more demo options and documentation.

## 🐛 Troubleshooting

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

- Ensure ports 3000 and 4000 are set to **Public** in the Ports panel
- If using Codespaces, check the forwarded URL in the Ports panel

### Database connection errors

- Verify PostgreSQL is running: `docker ps`
- Check DATABASE_URL in `apps/backend/.env`
- Restart: `semiont stop --service backend && semiont start --service backend`

### Authentication not working

- Check `NEXT_PUBLIC_ENABLE_LOCAL_AUTH=true` in `apps/frontend/.env.local`
- Verify backend is running on port 4000
- Clear browser cookies and retry

## 📚 Resources

- [GitHub Codespaces Documentation](https://docs.github.com/en/codespaces)
- [VS Code Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers)
- [Semiont Documentation](/workspace/README.md)
- [API Documentation](http://localhost:4000/docs) (when backend is running)
