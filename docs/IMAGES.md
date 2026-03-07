# Container Images

This document describes the container images published from the Semiont project.

## Overview

Semiont publishes **2 container images** to GitHub Container Registry (ghcr.io):

- **semiont-backend** - Backend API server
- **semiont-frontend** - Next.js frontend application

Both images support multiple platforms (amd64, arm64) and follow the unified versioning scheme managed through [`version.json`](../version.json).

---

## Container Images

Published to GitHub Container Registry at [ghcr.io](https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont).

### 1. semiont-backend

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-backend)

**Description:** Backend API server with multi-platform support (amd64, arm64)

**Pull image:**
```bash
docker pull ghcr.io/the-ai-alliance/semiont-backend:dev
```

**Run container:**
```bash
docker run -d \
  -p 4000:4000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/db \
  -e JWT_SECRET=your-secret-key-min-32-chars \
  --name semiont-backend \
  ghcr.io/the-ai-alliance/semiont-backend:dev
```

**Required Environment Variables:**
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret for JWT token signing (min 32 characters)

**Optional Environment Variables:**
- `PORT` - Server port (default: 4000)
- `NODE_ENV` - Environment mode (default: production)
- `CORS_ORIGIN` - CORS allowed origins

**Documentation:** [apps/backend/README.md](../apps/backend/README.md)

**Source:** [apps/backend/](../apps/backend/)

**Dockerfile:** [apps/backend/Dockerfile](../apps/backend/Dockerfile)

**Workflow:** [.github/workflows/publish-backend.yml](../.github/workflows/publish-backend.yml)

---

### 2. semiont-frontend

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-frontend)

**Description:** Next.js frontend application with multi-platform support (amd64, arm64)

**Pull image:**
```bash
docker pull ghcr.io/the-ai-alliance/semiont-frontend:dev
```

**Run container:**
```bash
docker run -d \
  -p 3000:3000 \
  -e SERVER_API_URL=http://localhost:4000 \
  -e NEXTAUTH_URL=http://localhost:3000 \
  -e NEXTAUTH_SECRET=your-secret-min-32-chars \
  --name semiont-frontend \
  ghcr.io/the-ai-alliance/semiont-frontend:dev
```

**Required Environment Variables:**
- `SERVER_API_URL` - Backend API URL
- `NEXTAUTH_URL` - Frontend URL for NextAuth callbacks
- `NEXTAUTH_SECRET` - Secret for NextAuth session encryption (min 32 characters)

**Optional Environment Variables:**
- `NEXT_PUBLIC_SITE_NAME` - Site name displayed in UI (default: "Semiont")
- `NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS` - Comma-separated list of allowed OAuth domains

**Documentation:** [apps/frontend/README.md](../apps/frontend/README.md)

**Source:** [apps/frontend/](../apps/frontend/)

**Dockerfile:** [apps/frontend/Dockerfile](../apps/frontend/Dockerfile)

**Workflow:** [.github/workflows/publish-frontend.yml](../.github/workflows/publish-frontend.yml)

---

## Docker Compose Example

Run both backend and frontend together:

```yaml
version: '3.8'
services:
  backend:
    image: ghcr.io/the-ai-alliance/semiont-backend:dev
    ports:
      - "4000:4000"
    environment:
      DATABASE_URL: postgresql://postgres:password@db:5432/semiont
      JWT_SECRET: your-secret-key-minimum-32-characters-long
      CORS_ORIGIN: http://localhost:3000
    depends_on:
      - db

  frontend:
    image: ghcr.io/the-ai-alliance/semiont-frontend:dev
    ports:
      - "3000:3000"
    environment:
      SERVER_API_URL: http://localhost:4000
      NEXTAUTH_URL: http://localhost:3000
      NEXTAUTH_SECRET: your-secret-minimum-32-characters-long
      NEXT_PUBLIC_SITE_NAME: Semiont
    depends_on:
      - backend

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: semiont
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

---

## Versioning

Container images follow the unified versioning system managed through [`version.json`](../version.json).

### Version Tags

**Development builds** (published on every push to main):
- Format: `{VERSION}-build.{RUN_NUMBER}`
- Example: `0.2.30-build.123`
- Tag: `dev` (always points to latest build)

**Stable releases** (manually triggered):
- Format: `{VERSION}`
- Example: `0.2.30`
- Tag: `latest`

**Commit-specific tags:**
- Format: `sha-{commit}`
- Examples: `sha-9d532bf`, `sha-8b53d8b`

### Publishing Process

Container images are published automatically via GitHub Actions:

**Triggers:**
- Push to `main` with changes to app source
- Manual workflow dispatch

**Process:**
1. Build multi-platform image (amd64, arm64)
2. Generate version: `{BASE_VERSION}-build.{RUN_NUMBER}`
3. Tag with:
   - `dev` (latest development build)
   - `{VERSION}-build.{RUN_NUMBER}` (specific build)
   - `sha-{COMMIT}` (git commit)
4. Push to ghcr.io

### Manual Publishing

Workflows support manual triggering via workflow dispatch:

```bash
# Trigger via GitHub CLI
gh workflow run publish-backend.yml
gh workflow run publish-frontend.yml

# With dry-run mode
gh workflow run publish-backend.yml --field dry_run=true

# For stable release
gh workflow run publish-backend.yml --field stable_release=true
gh workflow run publish-frontend.yml --field stable_release=true
```

---

## Registry Links

- **Container images:** https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont
- **GitHub Releases:** https://github.com/The-AI-Alliance/semiont/releases

---

## Support

For issues related to container images:
- **Bug reports:** https://github.com/The-AI-Alliance/semiont/issues
- **Security issues:** See [SECURITY.md](../SECURITY.md)
- **General questions:** https://github.com/The-AI-Alliance/semiont/discussions