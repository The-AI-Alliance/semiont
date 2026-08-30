# Gateway Local Development

Complete guide to local development for the Semiont gateway service.

**Related Documentation:**
- [Main README](../README.md) - Gateway overview
- [Semiont Protocol](../../../docs/protocol/README.md) - The eight verbs and the bus
- [Testing Guide](./TESTING.md) - Running tests
- [Deployment Guide](../../../docs/system/administration/DEPLOYMENT.md) - Deployment procedures

## Quick Start

### 🚀 Instant Setup with Semiont CLI (Recommended)

```bash
# From inside a knowledge-base repo — starts everything automatically!
semiont start

# This will:
# ✅ Start PostgreSQL, Neo4j, Qdrant, and Ollama containers
# ✅ Start gateway, worker, smelter, and weaver with the KB's config
# ✅ Ensure the Browser is running
# 🎉 Ready to develop in ~30 seconds!
```

**That's it!** Your complete development environment is running:
- **Browser**: http://localhost:3000
- **Gateway**: http://localhost:4000
- **Database**: PostgreSQL in Docker container

### 🛠 Manual Setup (Alternative)

```bash
# Install dependencies
npm install

# Run database migrations
npx prisma db push

# Start development server (with auto-restart on changes)
npm run dev

# Build for production (also run during the container image build)
npm run build
npm start
```

**Note on Building**: For local development, use `npm run dev` for auto-restart. Production builds happen in the `semiont-gateway` image build (`apps/gateway/Dockerfile`).

## Essential CLI Commands

```bash
# Full stack development
semiont start              # Start everything (infrastructure + the five services)
semiont stop               # Stop all services
semiont status              # Check service health

# Service-specific commands
semiont start --service database  # Start PostgreSQL container
semiont start --service gateway   # Start gateway (auto-starts database if needed)
semiont start --service browser  # Start the Browser only
semiont stop --service gateway    # Stop gateway service
semiont start --service gateway   # Restart gateway, leaving the rest of the stack up
```

## Why Use Semiont CLI?

- **🔄 Smart Dependencies**: The Browser auto-starts gateway, gateway auto-starts database
- **📦 Consistent Environment**: Everyone gets identical PostgreSQL setup
- **⚡ Zero Configuration**: No manual database setup, connection strings, or environment variables
- **🧹 Easy Reset**: Corrupted data? `--reset` gives you a fresh start
- **🎯 Focused Development**: Start only what you need
- **🐳 Container Runtime Flexibility**: Works with Apple Container, Docker, or Podman (auto-detected)

## Development Workflows

### First Time Setup

Run once:

```bash
brew install the-ai-alliance/semiont/semiont
cd /your/knowledge-base
semiont init --name "my-project"   # Writes .semiont/config + a semiontconfig
```

### Daily Development

Typical workflow:

```bash
# Start everything for full-stack development
semiont start

# Your services are now running! Develop normally...
# Browser: http://localhost:3000
# Gateway: http://localhost:4000
# Database: Managed automatically

# When done developing
semiont stop
```

### Restarting one service

```bash
semiont start --service gateway    # Rebuild-free restart of just the gateway
semiont start --service database   # Just PostgreSQL
```

`--service` takes one name: `gateway`, `worker`, `smelter`, `weaver`, `browser`,
`database`, `graph`, `vectors`, `inference`, `embedding`, or `traces`. The rest of the stack is
left untouched, and a restarted service rejoins the running stack's worker secret
automatically.

### Browser against a mock API

The mock lives in the Browser's own dev server, not in the launcher:

```bash
cd apps/browser && npm run dev:mock
```

### Fresh start (reset the database)

```bash
semiont stop
semiont clean                      # Removes PostgreSQL, Qdrant, and Neo4j state
semiont clean --store database     # Or just PostgreSQL
semiont start
```

`stop` deliberately leaves persistent state so the next `start` reuses it;
`clean` is the only thing that removes it. Neither touches the event log, which
lives in the KB's git repo.

## Container Runtime Options

The launcher works with **Apple Container**, **Docker**, and **Podman**. By default
it uses the runtime a successful `start` last used (recorded per machine), falling
back to the first one found on `PATH`. Choose explicitly with `--runtime`:

```bash
semiont start --runtime podman
```

### Using Podman

For better security and performance, you can use Podman:

**Linux Setup (Recommended):**

```bash
# 1. Install Podman (if not already installed)
sudo apt install podman  # Ubuntu/Debian
sudo dnf install podman  # Fedora/RHEL

# 2. Enable rootless Podman socket
systemctl --user enable --now podman.socket

# 3. Set environment variables
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"

# 4. Bring the stack up on Podman
semiont start --runtime podman
```

**macOS Setup:**

```bash
# 1. Install Podman via Homebrew
brew install podman

# 2. Initialize Podman machine
podman machine init
podman machine start

# 3. Configure environment
export DOCKER_HOST="$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"

# 4. Bring the stack up on Podman
semiont start --runtime podman
```

**Benefits of Using Podman:**
- **Enhanced Security**: Rootless containers by default (no root daemon)
- **Better Performance**: No VM overhead on Linux systems
- **Lower Resource Usage**: More efficient than Docker Desktop
- **No Background Daemon**: Containers run without persistent daemon

`DOCKER_HOST` matters for the gateway's **integration tests**, which provision
PostgreSQL with `@testcontainers/postgresql`; the launcher itself is told which
runtime to use by `--runtime`. Ryuk is disabled by the test setup, so there is no
`TESTCONTAINERS_RYUK_DISABLED` to export.

## Manual Setup (Alternative)

If you prefer manual setup or need to understand the internals:

### Prerequisites

- Node.js 18+ (recommend using nvm)
- Docker (for PostgreSQL container)
- A KB with `.semiont/semiontconfig/<name>.toml` holding credentials for the database, graph, and inference — `semiont init` generates one

### Manual Database Setup

**Option 1: Manual Docker (if not using Semiont CLI)**

```bash
# Start PostgreSQL in Docker
docker run --name semiont-postgres-dev \
  -e POSTGRES_PASSWORD=dev_password \
  -e POSTGRES_DB=semiont_dev \
  -e POSTGRES_USER=dev_user \
  -p 5432:5432 \
  -d postgres:15-alpine
```

**Option 2: Local PostgreSQL**

```bash
# Create database
createdb semiont_dev

# Connection string for .env
DATABASE_URL="postgresql://dev_user:dev_password@localhost:5432/semiont_dev"
```

### Manual Development Workflow

**1. Initial Setup**

```bash
# Clone and install
cd apps/gateway
npm install

# Configure environment
cp .env.example .env
# Edit .env with your local settings

# Initialize database
npx prisma generate
npx prisma db push
```

**2. Start Development Server**

```bash
# Run with hot reload
npm run dev

# Server starts on http://localhost:4000
```

**3. Database Development**

```bash
# Open Prisma Studio (database GUI)
npx prisma studio

# Reset database (caution: deletes all data)
npx prisma db push --force-reset

# Generate Prisma client after schema changes
npx prisma generate
```

## Environment Configuration

Create `.env` file with these local development settings:

```env
# Server
NODE_ENV=development
PORT=4000

# Database
DATABASE_URL="postgresql://postgres:localpassword@localhost:5432/semiont"

# JWT (use a long random string for local dev). May also be an ordered,
# comma-separated key ring during a rotation — first key signs, all verify.
JWT_SECRET="local-development-secret-min-32-characters-long"

# OAuth (optional for local dev)
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"

```

## Testing API Endpoints

```bash
# Health check (no auth required - for ALB health checks)
curl http://localhost:4000/api/health

# API documentation (no auth required)
curl http://localhost:4000/api

# Test greeting endpoint (requires authentication)
TOKEN="your-jwt-token"
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/hello

# Test status endpoint (requires authentication)
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/status
```

## Development Tools

### Prisma Studio

Visual database editor:

```bash
npx prisma studio
# Opens at http://localhost:5555
```

### API Testing

Recommended tools:
- [HTTPie](https://httpie.io/) - Command line HTTP client
- [Postman](https://www.postman.com/) - GUI API testing
- [Thunder Client](https://marketplace.visualstudio.com/items?itemName=rangav.vscode-thunder-client) - VS Code extension

### Database Migrations

```bash
# Create migration from schema changes
npx prisma migrate dev --name add_user_role

# Apply migrations
npx prisma migrate deploy

# Reset database
npx prisma migrate reset
```

## Common Development Tasks

### Adding Test Data

Create `prisma/seed.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.user.create({
    data: {
      email: 'test@example.com',
      name: 'Test User',
      provider: 'google',
      providerId: 'test-id',
    },
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

Run: `npx ts-node prisma/seed.ts`

### Debugging

**1. VS Code Debug Configuration**

Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Gateway",
  "runtimeExecutable": "npm",
  "runtimeArgs": ["run", "dev"],
  "cwd": "${workspaceFolder}/apps/gateway",
  "console": "integratedTerminal"
}
```

**2. Enable Debug Logging**

```bash
# Winston logging (recommended)
LOG_LEVEL=debug npm start

# See all HTTP requests, auth attempts, and errors
# For complete logging guide, see docs/LOGGING.md
```

**Alternative: Framework-specific debug**

```env
# In .env (legacy)
DEBUG=hono:*
PRISMA_LOG=query,info,warn,error
```

**3. Inspect Database Queries**

```typescript
// Temporarily add to see SQL queries
const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});
```

## Performance Tips

1. **Database Connection Pooling**
   - Prisma handles this automatically
   - Default pool size: 10 connections

2. **Hot Reload Optimization**
   - Use `npm run dev` for file watching
   - Nodemon restarts only on file changes

3. **Type Checking**
   - Run `npm run typecheck` periodically
   - VS Code shows errors in real-time

## Troubleshooting

### "Cannot connect to database"

```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Check connection string format
echo $DATABASE_URL
```

### "JWT_SECRET too short"

- Each key must be at least 32 characters — the check is per key, not on the whole
  string, since `JWT_SECRET` may be a comma-separated rotation ring
- Generate secure secret: `openssl rand -hex 32`

### "Prisma client not found"

```bash
# Regenerate Prisma client
npx prisma generate

# Clear node_modules and reinstall
rm -rf node_modules
npm install
```

### "Port already in use"

```bash
# Find process using port 4000
lsof -i :4000

# Kill process
kill -9 <PID>
```

## Configuration Management

Configuration is TOML, read from two files at startup ([`src/index.ts`](../src/index.ts)):

| File | Contents | Committed? |
|---|---|---|
| `<SEMIONT_ROOT>/.semiont/config` | Project anchor: the KB's name and its permanent `did:web` identity | Yes |
| `<SEMIONT_ROOT>/.semiont/semiontconfig/<name>.toml` | Per-environment settings: database, graph, vectors, embedding, inference | Yes |

The launcher stages a per-service copy of that config and mounts it into each
container at `/home/semiont/.semiontconfig`, which is the path the process reads.

- `SEMIONT_ROOT` — path to the knowledge-base working tree. **Required**; the process throws without it.
- The environment block comes from `[defaults] environment` inside the config file.

`loadEnvironmentConfig(projectRoot, env)` merges them into an `EnvironmentConfig`
(`@semiont/core`). `services.gateway` must be present or startup fails.

Beyond that, the gateway reads from the environment directly:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. In the container image the CMD derives it from `services.database` (`src/cli/db-url.ts`) when unset; set it explicitly to override, e.g. for an external or TLS-requiring database |
| `JWT_SECRET` | Token signing. An ordered, comma-separated key ring: the first key signs, every key verifies; minimum 32 characters **per key**. A single value is the one-key case. See [Rotating `JWT_SECRET`](../../../docs/system/administration/AUTHENTICATION.md#rotating-jwt_secret-without-signing-everyone-out) |
| `SEMIONT_WORKER_SECRET` | Shared secret for the software-agent token exchange |

`semiont init` generates both TOML files. See the
[Configuration Guide](../../../docs/system/administration/CONFIGURATION.md) for the
full schema, and [SECRETS.md](../../../docs/system/services/SECRETS.md) for
credential handling.

### Adding a configuration key

1. Add it to the TOML schema and to `EnvironmentConfig` in `@semiont/core`
2. Thread it through `loadEnvironmentConfig` / [`src/utils/config.ts`](../src/utils/config.ts)
3. Read it off `config` at the call site — not from `process.env`, so one loader stays the single source of truth

## Related Documentation

- [Semiont Protocol](../../../docs/protocol/README.md) - The eight verbs and the bus
- [Authentication Guide](./AUTHENTICATION.md) - JWT, OAuth, and MCP authentication
- [Testing Guide](./TESTING.md) - Running and writing tests
- [Deployment Guide](../../../docs/system/administration/DEPLOYMENT.md) - Production deployment procedures
- [Contributing Guide](../../../CONTRIBUTING.md) - Code style and development patterns

---

**Last Updated**: 2025-10-23
