# Demo Devcontainer Plan

## Overview

Create a standalone, production-ready demo environment that uses **published Semiont artifacts** instead of building from source. This environment is optimized for:

- **Quick startup** - No lengthy compilation, just pull containers and install packages
- **Demonstrating features** - Focus on using Semiont, not developing it
- **Portability** - Can be split into separate repository in the future
- **Production-like** - Uses the same artifacts that end users would deploy

## Architecture

### Container Strategy

Use **Docker Compose** to orchestrate three containers:

1. **PostgreSQL** (`postgres:16-alpine`) - Database service
2. **Semiont Backend** (`ghcr.io/the-ai-alliance/semiont-backend:0.2.0`) - API server
3. **Semiont Frontend** (`ghcr.io/the-ai-alliance/semiont-frontend:0.2.0`) - Web UI

### NPM Package Installation

Install published packages into the devcontainer workspace:

1. **@semiont/cli@0.2.0** - Command-line tool (global install)
2. **@semiont/api-client@0.2.0** - TypeScript SDK (local to demo/)

### Version Management

All Semiont versions pinned to `0.2.0` initially:
- Update via environment variable `SEMIONT_VERSION=0.2.0`
- Single source of truth for version across all artifacts
- Easy to update for testing new releases

## Directory Structure

```
demo/
├── .devcontainer/
│   ├── devcontainer.json       # Devcontainer configuration
│   ├── docker-compose.yml      # Service orchestration
│   ├── .env.template           # Environment template
│   ├── setup-demo.sh           # Post-create setup script
│   ├── welcome.txt             # Welcome message
│   └── README.md               # Devcontainer-specific docs
├── CONTAINER.md                # This file
├── README.md                   # Updated demo README
└── ... (existing demo files)
```

## Implementation Plan

### Phase 1: Docker Compose Configuration

**File: `demo/.devcontainer/docker-compose.yml`**

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: semiont_demo
      POSTGRES_USER: semiont
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-semiont}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U semiont"]
      interval: 5s
      timeout: 5s
      retries: 5

  backend:
    image: ghcr.io/the-ai-alliance/semiont-backend:${SEMIONT_VERSION:-0.2.0}
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://semiont:${POSTGRES_PASSWORD:-semiont}@postgres:5432/semiont_demo
      JWT_SECRET: ${JWT_SECRET:-demo-jwt-secret-change-in-production}
      PORT: 4000
      NODE_ENV: production
      CORS_ORIGIN: http://localhost:3000
      ENABLE_LOCAL_AUTH: "true"
      # Optional AI services
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      NEO4J_URI: ${NEO4J_URI:-}
      NEO4J_USERNAME: ${NEO4J_USERNAME:-}
      NEO4J_PASSWORD: ${NEO4J_PASSWORD:-}
      NEO4J_DATABASE: ${NEO4J_DATABASE:-}
    ports:
      - "4000:4000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/health"]
      interval: 10s
      timeout: 5s
      retries: 5

  frontend:
    image: ghcr.io/the-ai-alliance/semiont-frontend:${SEMIONT_VERSION:-0.2.0}
    depends_on:
      backend:
        condition: service_healthy
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:4000
      NEXTAUTH_URL: http://localhost:3000
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET:-demo-nextauth-secret-change-in-production}
      NEXT_PUBLIC_SITE_NAME: Semiont Demo
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

### Phase 2: Devcontainer Configuration

**File: `demo/.devcontainer/devcontainer.json`**

```json
{
  "name": "Semiont Demo Environment",

  "dockerComposeFile": "docker-compose.yml",
  "service": "demo-workspace",
  "workspaceFolder": "/workspace/demo",

  "features": {
    "ghcr.io/devcontainers/features/node:1": {
      "version": "22"
    },
    "ghcr.io/devcontainers/features/docker-outside-of-docker:1": {},
    "ghcr.io/devcontainers/features/github-cli:1": {}
  },

  "postCreateCommand": "bash .devcontainer/setup-demo.sh",

  "forwardPorts": [3000, 4000, 5432],

  "portsAttributes": {
    "3000": {
      "label": "Frontend (Semiont UI)",
      "onAutoForward": "notify"
    },
    "4000": {
      "label": "Backend (API)",
      "onAutoForward": "silent"
    },
    "5432": {
      "label": "PostgreSQL",
      "onAutoForward": "silent"
    }
  },

  "customizations": {
    "codespaces": {
      "openFiles": [
        "README.md",
        "datasets/README.md"
      ]
    },
    "vscode": {
      "extensions": [
        "dbaeumer.vscode-eslint",
        "esbenp.prettier-vscode",
        "ms-azuretools.vscode-docker"
      ],
      "settings": {
        "terminal.integrated.defaultProfile.linux": "bash",
        "editor.formatOnSave": true
      }
    }
  },

  "containerEnv": {
    "SEMIONT_VERSION": "0.2.0",
    "SEMIONT_API_URL": "http://localhost:4000",
    "NODE_ENV": "production"
  },

  "remoteUser": "node"
}
```

**Note:** Need to add a `demo-workspace` service to docker-compose.yml for the devcontainer itself.

### Phase 3: Setup Script

**File: `demo/.devcontainer/setup-demo.sh`**

```bash
#!/bin/bash
set -euo pipefail

SEMIONT_VERSION="${SEMIONT_VERSION:-0.2.0}"

echo "=========================================="
echo "   SEMIONT DEMO ENVIRONMENT SETUP"
echo "=========================================="
echo ""
echo "Version: $SEMIONT_VERSION"
echo ""

# Install Semiont CLI globally
echo "📦 Installing @semiont/cli@$SEMIONT_VERSION..."
npm install -g @semiont/cli@$SEMIONT_VERSION

# Install demo dependencies (includes @semiont/api-client)
echo "📦 Installing demo dependencies..."
cd /workspace/demo
npm install

# Wait for services to be healthy
echo "⏳ Waiting for services to start..."
timeout 120 bash -c 'until docker compose ps | grep -q "healthy.*backend"; do sleep 2; done' || {
    echo "❌ Backend failed to start"
    docker compose logs backend
    exit 1
}

timeout 60 bash -c 'until docker compose ps | grep -q "healthy.*frontend"; do sleep 2; done' || {
    echo "❌ Frontend failed to start"
    docker compose logs frontend
    exit 1
}

# Create default demo user
echo "👤 Creating demo user..."
DEMO_EMAIL="demo@example.com"
DEMO_PASSWORD="demo123"

# Use CLI to create user (assuming it has user creation command)
# Fallback to direct API call if needed
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PASSWORD\",\"name\":\"Demo User\"}" \
  || echo "⚠️  User may already exist"

# Save credentials to demo/.env
cat > /workspace/demo/.env <<EOF
SEMIONT_API_URL=http://localhost:4000
DEMO_EMAIL=$DEMO_EMAIL
DEMO_PASSWORD=$DEMO_PASSWORD
SEMIONT_VERSION=$SEMIONT_VERSION
EOF

echo ""
echo "✅ Demo environment ready!"
echo ""
echo "=========================================="
echo "   QUICK START"
echo "=========================================="
echo ""
echo "🌐 Frontend:  http://localhost:3000"
echo "🔌 Backend:   http://localhost:4000"
echo "📊 Database:  postgresql://semiont:semiont@localhost:5432/semiont_demo"
echo ""
echo "👤 Demo Account:"
echo "   Email:    $DEMO_EMAIL"
echo "   Password: $DEMO_PASSWORD"
echo ""
echo "🎯 Run Interactive Demo:"
echo "   cd demo"
echo "   npm run demo:interactive"
echo ""
echo "📖 Documentation:"
echo "   cat demo/README.md"
echo ""
```

### Phase 4: Environment Template

**File: `demo/.devcontainer/.env.template`**

```bash
# Semiont Version
SEMIONT_VERSION=0.2.0

# Database
POSTGRES_PASSWORD=semiont

# Backend Secrets
JWT_SECRET=demo-jwt-secret-change-in-production

# Frontend Secrets
NEXTAUTH_SECRET=demo-nextauth-secret-change-in-production

# Optional: Anthropic AI (for annotation features)
# Get key from: https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=

# Optional: Neo4j Graph Database (for graph features)
# Get from: https://neo4j.com/cloud/aura/
NEO4J_URI=
NEO4J_USERNAME=
NEO4J_PASSWORD=
NEO4J_DATABASE=
```

### Phase 5: Documentation Updates

**File: `demo/.devcontainer/README.md`**

```markdown
# Demo Devcontainer

This devcontainer provides a complete, production-ready Semiont demo environment.

## What's Included

- **Semiont Frontend** (0.2.0) - Web UI at http://localhost:3000
- **Semiont Backend** (0.2.0) - API server at http://localhost:4000
- **PostgreSQL** (16) - Database at localhost:5432
- **@semiont/cli** (0.2.0) - Command-line tool (global)
- **@semiont/api-client** (0.2.0) - TypeScript SDK (in demo/)

## Architecture

All Semiont components run as **published containers/packages** rather than building from source:
- Backend: `ghcr.io/the-ai-alliance/semiont-backend:0.2.0`
- Frontend: `ghcr.io/the-ai-alliance/semiont-frontend:0.2.0`
- CLI: `@semiont/cli@0.2.0` (npm)
- API Client: `@semiont/api-client@0.2.0` (npm)

## Quick Start

1. Open this folder in Codespaces or devcontainer
2. Wait for setup to complete (~2 minutes)
3. Visit http://localhost:3000
4. Login with demo credentials (shown in terminal)
5. Run interactive demo: `npm run demo:interactive`

## Configuration

Environment variables are loaded from `.env` (created during setup).

To use optional features:
1. Copy `.devcontainer/.env.template` to `.devcontainer/.env`
2. Add your API keys (Anthropic, Neo4j)
3. Rebuild container

## Version Updates

To test a different Semiont version:
1. Update `SEMIONT_VERSION` in `.devcontainer/.env`
2. Rebuild container: Cmd/Ctrl+Shift+P → "Rebuild Container"

## Troubleshooting

**Services not starting:**
```bash
docker compose logs backend
docker compose logs frontend
docker compose logs postgres
```

**Reset environment:**
```bash
docker compose down -v
docker compose up -d
```

**Check service health:**
```bash
docker compose ps
```
```

## Differences from Main Devcontainer

| Aspect | Main Devcontainer | Demo Devcontainer |
|--------|------------------|-------------------|
| **Purpose** | Development | Demonstration |
| **Build Time** | 5-7 minutes (compile from source) | 1-2 minutes (pull containers) |
| **Semiont Source** | Local source code | Published containers (ghcr.io) |
| **Packages** | Built locally | Installed from npm |
| **Customization** | Full source access | Configuration only |
| **Target Users** | Contributors | End users, evaluators |
| **Workspace** | `/workspace` (repo root) | `/workspace/demo` |
| **Services** | Built in container | Docker Compose |
| **Database** | Local PostgreSQL service | Docker Compose container |

## Migration Path

This demo environment is designed to be **split into a separate repository** in the future:

1. **Standalone Repository Structure:**
   ```
   semiont-demo/
   ├── .devcontainer/       (demo devcontainer)
   ├── datasets/            (from demo/datasets)
   ├── package.json         (demo dependencies only)
   ├── demo.ts              (from demo/demo.ts)
   ├── README.md            (from demo/README.md)
   └── docker-compose.yml   (production deployment)
   ```

2. **Changes Required:**
   - Update paths (remove `demo/` prefix)
   - Update package.json dependencies (use published packages only)
   - Add standalone deployment docs
   - Add GitHub Actions for CI/CD

3. **Benefits:**
   - Cleaner separation of concerns
   - Independent release cycle for demos
   - Simpler onboarding for new users
   - Easier to maintain demo datasets

## Codespaces Link

To open this demo environment directly in Codespaces:

```markdown
[![Open Demo in Codespaces](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new/The-AI-Alliance/semiont?devcontainer_path=demo%2F.devcontainer%2Fdevcontainer.json)
```

## Future Enhancements

1. **Pre-seeded Data** - Include sample documents/annotations
2. **Guided Tutorials** - Interactive walkthrough of features
3. **Video Demos** - Recorded demo sessions
4. **API Playground** - Built-in API testing interface
5. **Performance Metrics** - Built-in monitoring dashboard
6. **Multi-version Support** - Quick switching between Semiont versions
7. **Offline Mode** - Cached containers for offline demos

## Implementation Checklist

- [ ] Create `demo/.devcontainer/` directory
- [ ] Write `docker-compose.yml` with all three services
- [ ] Create `devcontainer.json` with proper configuration
- [ ] Write `setup-demo.sh` setup script
- [ ] Create `.env.template` with all required variables
- [ ] Write devcontainer `README.md`
- [ ] Update main `demo/README.md` with Codespaces link
- [ ] Test in local devcontainer
- [ ] Test in GitHub Codespaces
- [ ] Add demo environment badge to main README
- [ ] Document version update process
- [ ] Create troubleshooting guide

## Version History

- **0.2.0** - Initial demo devcontainer design
- Aligned with stable release artifacts
- Uses published containers and packages
- Production-ready configuration
