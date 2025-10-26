# Backend Local Development

Complete guide to local development for the Semiont backend service.

**Related Documentation:**
- [Main README](../README.md) - Backend overview
- [API Documentation](./API.md) - API endpoints reference
- [Testing Guide](./TESTING.md) - Running tests
- [Deployment Guide](./DEPLOYMENT.md) - Deployment procedures

## Quick Start

### 🚀 Instant Setup with Semiont CLI (Recommended)

```bash
# Set your development environment
export SEMIONT_ENV=local

# From project root - starts everything automatically!
semiont start

# This will:
# ✅ Start PostgreSQL container with correct schema
# ✅ Start backend with proper environment
# ✅ Start frontend connected to backend
# 🎉 Ready to develop in ~30 seconds!
```

**That's it!** Your complete development environment is running:
- **Frontend**: http://localhost:3000
- **Backend**: http://localhost:3001
- **Database**: PostgreSQL in Docker container

### 🛠 Manual Setup (Alternative)

```bash
# Install dependencies
npm install

# Run database migrations
npx prisma db push

# Start development server (with auto-restart on changes)
npm run dev

# Build for production (handled automatically by semiont publish)
npm run build
npm start
```

**Note on Building**: For local development, use `npm run dev` for auto-restart. For production deployment, `semiont publish` handles building TypeScript locally before creating Docker images. See [DEPLOYMENT.md](./DEPLOYMENT.md) for details.

## Essential CLI Commands

```bash
# Set your environment once
export SEMIONT_ENV=local

# Full stack development
semiont start              # Start everything (database + backend + frontend)
semiont start --force      # Fresh start with clean database
semiont stop               # Stop all services
semiont check              # Check service health

# Service-specific commands
semiont start --service database  # Start PostgreSQL container
semiont start --service backend   # Start backend (auto-starts database if needed)
semiont start --service frontend  # Start frontend only
semiont stop --service backend    # Stop backend service
semiont restart --service backend # Restart backend with fresh connection
```

## Why Use Semiont CLI?

- **🔄 Smart Dependencies**: Frontend auto-starts backend, backend auto-starts database
- **📦 Consistent Environment**: Everyone gets identical PostgreSQL setup
- **⚡ Zero Configuration**: No manual database setup, connection strings, or environment variables
- **🧹 Easy Reset**: Corrupted data? `--reset` gives you a fresh start
- **🎯 Focused Development**: Start only what you need
- **🐳 Container Runtime Flexibility**: Works with Docker or Podman (auto-detected)

## Development Workflows

### First Time Setup

Run once:

```bash
cd /your/project/root
npm install  # Installs dependencies for all apps
semiont init --name "my-project"  # Initialize configuration
export SEMIONT_ENV=local  # Set default environment
```

### Daily Development

Typical workflow:

```bash
# Start everything for full-stack development
semiont start

# Your services are now running! Develop normally...
# Frontend: http://localhost:3000
# Backend: http://localhost:3001
# Database: Managed automatically

# When done developing
semiont stop
```

### Backend-Only Development

```bash
semiont local backend start
# Only database + backend running
```

### Frontend with Mock API

```bash
semiont local frontend start --mock
# Only frontend running, no backend needed
```

### Fresh Start (Reset Database)

```bash
semiont local start --reset
# Clean database with sample data
```

## Container Runtime Options

The Semiont CLI automatically detects and works with both **Docker** and **Podman**.

### Using Podman Instead of Docker

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
export TESTCONTAINERS_RYUK_DISABLED=true

# 4. Use Semiont CLI normally - it will detect Podman automatically
semiont local start
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
export TESTCONTAINERS_RYUK_DISABLED=true

# 4. Use normally
semiont local start
```

**Benefits of Using Podman:**
- **Enhanced Security**: Rootless containers by default (no root daemon)
- **Better Performance**: No VM overhead on Linux systems
- **Lower Resource Usage**: More efficient than Docker Desktop
- **No Background Daemon**: Containers run without persistent daemon

The Semiont CLI will automatically detect your container runtime and configure accordingly.

## Manual Setup (Alternative)

If you prefer manual setup or need to understand the internals:

### Prerequisites

- Node.js 18+ (recommend using nvm)
- Docker (for PostgreSQL container)
- Secrets configured via `semiont secrets` command

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
cd apps/backend
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

# Server starts on http://localhost:3001
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

# JWT (use a long random string for local dev)
JWT_SECRET="local-development-secret-min-32-characters-long"
JWT_EXPIRES_IN="7d"

# OAuth (optional for local dev)
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"

# Frontend URL
FRONTEND_URL="http://localhost:3000"
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
  "name": "Debug Backend",
  "runtimeExecutable": "npm",
  "runtimeArgs": ["run", "dev"],
  "cwd": "${workspaceFolder}/apps/backend",
  "console": "integratedTerminal"
}
```

**2. Enable Debug Logging**

```env
# In .env
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
   - Run `npm run type-check` periodically
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

- Must be at least 32 characters
- Generate secure secret: `openssl rand -base64 32`

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

The backend uses environment-specific configuration files from `/config/environments/`:

**1. Environment Configuration** - Edit `/config/environments/[env].json`:

```json
{
  "services": {
    "backend": {
      "port": 3001,
      "deployment": { "type": "aws" }
    },
    "database": {
      "name": "semiont_prod",
      "deployment": { "type": "aws" }
    }
  },
  "aws": {
    "region": "us-east-2",
    "accountId": "123456789012"
  }
}
```

**2. Secrets Management** - Use the semiont CLI:

```bash
# Production secrets (AWS Secrets Manager)
semiont configure production set oauth/google
semiont configure staging set jwt-secret

# Check secret status
semiont configure production get oauth/google
```

**3. Adding New Configuration**:
- Add to appropriate environment JSON file in `/config/environments/`
- Update validation in `src/config/env.ts` if needed
- Configuration is loaded automatically based on SEMIONT_ENV

## Related Documentation

- [API Documentation](./API.md) - API endpoints and request/response formats
- [Authentication Guide](./AUTHENTICATION.md) - JWT, OAuth, and MCP authentication
- [Testing Guide](./TESTING.md) - Running and writing tests
- [Deployment Guide](./DEPLOYMENT.md) - Production deployment procedures
- [Contributing Guide](./CONTRIBUTING.md) - Code style and development patterns

---

**Last Updated**: 2025-10-23
